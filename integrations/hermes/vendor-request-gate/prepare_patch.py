"""Prepare a pinned native patch in a NEW isolated directory; never edit the source input."""
import argparse, ast, difflib, hashlib, json, subprocess
from pathlib import Path
PIN='ccc695635094d7615373db267b77f894d978b1a0'
HERE=Path(__file__).resolve().parent
def insert(tree,name,code):
    nodes=[n for n in ast.parse(tree).body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name]
    if len(nodes)!=1:raise ValueError('Native function mismatch: '+name)
    n=nodes[0];first=n.body[0]
    line=first.end_lineno if isinstance(first,ast.Expr) and isinstance(first.value,ast.Constant) and isinstance(first.value.value,str) else first.lineno-1
    lines=tree.splitlines(keepends=True);lines.insert(line,''.join('    '+s+'\n' for s in code.splitlines()));return ''.join(lines)
def patched(name,text):
    if name=='agent/anthropic_adapter.py':
        old='def _new_sdk_client(sdk, kwargs: dict[str, Any], headers: dict[str, str], route: str | None = None):';assert text.count(old)==1
        text=text.replace(old,old.replace('None):','None, gate_session_id: str | None = None):'))
        old='def build_anthropic_client(api_key, base_url: str | None = None, timeout: float | None = None, *, drop_context_1m_beta: bool = False):';assert text.count(old)==1
        text=text.replace(old,old.replace('False):','False, gate_session_id: str | None = None):'))
        text=insert(text,'_build_anthropic_client_with_bearer_hook',"from agent.envoi_request_gate import forbid_variant\nforbid_variant('PROVIDER_GATE_BEARER_TRANSPORT_UNSUPPORTED')")
        text=insert(text,'build_anthropic_bedrock_client',"from agent.envoi_request_gate import forbid_variant\nforbid_variant('PROVIDER_GATE_FOREIGN_PROVIDER')")
        old='    return sdk.Anthropic(**kwargs)\n';assert text.count(old)==1
        text=text.replace(old,'    from agent.envoi_request_gate import construct_client\n    return construct_client(sdk, kwargs, gate_session_id)\n')
        old='    return _new_sdk_client(sdk, kwargs, headers, route=base_url)\n';assert text.count(old)==2
        # Only the static builder has this parameter; the bearer path refuses required mode.
        offset=text.index('def build_anthropic_client(');text=text[:offset]+text[offset:].replace(old,'    return _new_sdk_client(sdk, kwargs, headers, route=base_url, gate_session_id=gate_session_id)\n',1)
    elif name=='agent/agent_init.py':
        text=insert(text,'_build_client',"from agent.envoi_request_gate import guard_provider\nguard_provider(agent.provider, agent.model)")
        old='agent._anthropic_client = build_anthropic_client(effective_key, base_url, timeout=_provider_timeout)';assert text.count(old)==1
        text=text.replace(old,'agent._anthropic_client = build_anthropic_client(effective_key, base_url, timeout=_provider_timeout, gate_session_id=agent.session_id)')
    elif name=='hermes_cli/runtime_provider.py':
        text=insert(text,'_runtime',"from agent.envoi_request_gate import guard_provider, pin_endpoint\nguard_provider(provider)\nbase_url = pin_endpoint(base_url)")
        old='    requested_provider = resolve_requested_provider(requested)\n';assert text.count(old)==1
        text=text.replace(old,old+'    from agent.envoi_request_gate import guard_provider, pin_endpoint\n    guard_provider(requested_provider, target_model)\n    pin_endpoint(explicit_base_url)\n')
        old='    provider = resolve_provider(requested_provider, explicit_api_key=explicit_api_key, explicit_base_url=explicit_base_url)\n';assert text.count(old)==1
        text=text.replace(old,old+'    from agent.envoi_request_gate import guard_provider\n    guard_provider(provider, target_model)\n')
        text=insert(text,'_resolve_vertex_runtime',"from agent.envoi_request_gate import forbid_variant\nforbid_variant('PROVIDER_GATE_FOREIGN_PROVIDER')")
        text=insert(text,'_auto_detect_local_model',"from agent.envoi_request_gate import forbid_variant\nforbid_variant('PROVIDER_GATE_UNPINNED_DISCOVERY_REFUSED')")
    elif name=='agent/auxiliary_client.py':
        text=insert(text,'resolve_provider_client',"from agent.envoi_request_gate import guard_provider\nguard_provider(provider, model)")
        text=insert(text,'resolve_provider_client',"from agent.envoi_request_gate import pin_endpoint\npin_endpoint(explicit_base_url)")
        text=insert(text,'_create_openai_client',"from agent.envoi_request_gate import forbid_variant\nforbid_variant('PROVIDER_GATE_FOREIGN_TRANSPORT')")
        text=insert(text,'_try_discovery_chain',"from agent.envoi_request_gate import forbid_variant\nforbid_variant('PROVIDER_GATE_UNPINNED_DISCOVERY_REFUSED')")
        for fn in ['_try_openrouter','_try_nous','_try_custom_endpoint','_build_xai_oauth_aux_client','_build_codex_client','_try_azure_foundry','_build_bedrock_client','_build_vertex_client','_resolve_external_process_branch']:
            text=insert(text,fn,"from agent.envoi_request_gate import forbid_variant\nforbid_variant('PROVIDER_GATE_FOREIGN_PROVIDER')")
        for fn in ['resolve_vision_provider_client','_resolve_strict_vision_backend','_get_cached_client']:
            text=insert(text,fn,"from agent.envoi_request_gate import guard_provider\nguard_provider(provider, model)")
        old='                return cached_client, _compat_model(cached_client, model, cached_default)\n';assert text.count(old)==1
        text=text.replace(old,'                from agent.envoi_request_gate import guard_cached_client\n                guard_cached_client(cached_client)\n'+old)
        old='    return client, _compat_model(client, model, default_model)\n';assert text.count(old)==1
        text=text.replace(old,'    from agent.envoi_request_gate import guard_cached_client\n    if client is not None:\n        guard_cached_client(client)\n'+old)
        text=insert(text,'_to_async_client',"from agent.envoi_request_gate import policy, guard_cached_client\nif policy() is not None and not isinstance(sync_client, _AuxProbeClientStub):\n    guard_cached_client(sync_client)")
        old='    from agent.anthropic_credentials import _is_oauth_token\n';assert text.count(old)==1
        text=text.replace(old,'    from agent.envoi_request_gate import pin_endpoint\n    base_url = pin_endpoint(base_url)\n'+old)
        old='real_client = build_anthropic_client(token, base_url)';assert text.count(old)==1
        text=text.replace(old,'real_client = build_anthropic_client(token, base_url, gate_session_id=_normalize_main_runtime(None).get("session_id"))')
    elif name=='tools/tool_search.py':
        old='(deferrable if is_deferrable_tool_name(name, defer_tools) else visible).append(td)';assert text.count(old)==1
        text=insert(text,'classify_tools',"from agent.envoi_request_gate import eager_case_tool")
        text=text.replace(old,'(deferrable if not eager_case_tool(name) and is_deferrable_tool_name(name, defer_tools) else visible).append(td)')
    elif name=='gateway/control_socket.py':
        old='        self.private_handlers = {}\n';assert text.count(old)==1
        text=text.replace(old,"        self.private_handlers = {'envoi-request-gate-status': self._envoi_request_gate_status}\n")
        old='    def _session_ticket(self, request: dict, peer_subject: Optional[str]) -> dict:\n';assert text.count(old)==1
        method="""    def _envoi_request_gate_status(self, params: dict, peer_subject: str) -> dict:
        from agent.envoi_request_gate import runtime_status, RequestGateRefused
        if not peer_subject or self.ticket_store is None or set(params) != {'instance_id','challenge'} or params['instance_id'] != self.ticket_store.instance_id:
            raise RequestGateRefused('PROVIDER_GATE_ATTESTATION_REFUSED')
        return runtime_status(self.ticket_store.instance_id, params['challenge'])

"""
        text=text.replace(old,method+old)
    ast.parse(text);return text
def main():
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--output',required=True);p.add_argument('--write-fixtures',action='store_true');a=p.parse_args()
    source=Path(a.source).resolve();out=Path(a.output).resolve()
    if out==source or source in out.parents or out.exists():raise ValueError('NEW_ISOLATED_OUTPUT_REQUIRED')
    head=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    if head!=PIN:raise ValueError('NATIVE_SOURCE_PIN_MISMATCH')
    names=['agent/anthropic_adapter.py','agent/agent_init.py','agent/auxiliary_client.py','hermes_cli/runtime_provider.py','tools/tool_search.py','gateway/control_socket.py']
    manifest={};diff=[];fixtures={}
    for name in names:
        b=(source/name).read_bytes();blob=subprocess.check_output(['git','-C',str(source),'show',PIN+':'+name])
        if b!=blob:raise ValueError('NATIVE_DIRTY_BYTES_REFUSED: '+name)
        before=b.decode('utf-8');after=patched(name,before)
        target=out/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(after,encoding='utf-8',newline='\n')
        manifest[name]={'beforeSha256':hashlib.sha256(b).hexdigest(),'afterSha256':hashlib.sha256(after.encode()).hexdigest()}
        diff+=list(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/'+name,tofile='b/'+name))
        wanted={'_new_sdk_client','_build_anthropic_client_with_bearer_hook','build_anthropic_bedrock_client','_build_client','_runtime','resolve_provider_client','_create_openai_client','_try_discovery_chain','_try_anthropic','classify_tools','_try_openrouter','_try_nous','_try_custom_endpoint','_build_xai_oauth_aux_client','_build_codex_client','_try_azure_foundry','_build_bedrock_client','_build_vertex_client','_resolve_external_process_branch','resolve_vision_provider_client','_resolve_strict_vision_backend','_get_cached_client','_to_async_client','_resolve_vertex_runtime','_auto_detect_local_model','resolve_runtime_provider','_ladder_rungs'}
        snippets={}
        for node in ast.parse(after).body:
            if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in wanted | {'_AsyncCompletionsAdapter','_AsyncAuxiliaryClientBase','AsyncAnthropicAuxiliaryClient'}:snippets[node.name]=ast.get_source_segment(after,node)
            if isinstance(node,ast.ClassDef) and node.name=='GatewayControlServer':
                method=next(n for n in node.body if isinstance(n,ast.FunctionDef) and n.name=='_envoi_request_gate_status')
                snippets[method.name]=ast.get_source_segment(after,method)
        fixtures[name]=snippets
    module=(HERE/'envoi_request_gate.py').read_bytes();(out/'agent/envoi_request_gate.py').write_bytes(module)
    diff+=list(difflib.unified_diff([],module.decode().splitlines(True),fromfile='/dev/null',tofile='b/agent/envoi_request_gate.py'))
    bundle={'nativeBase':PIN,'purpose':'Review-only isolated patch; no installed source/profile/admission changed','sourceFiles':manifest,'moduleSha256':hashlib.sha256(module).hexdigest()}
    (out/'native-patch-manifest.json').write_text(json.dumps(bundle,indent=2)+'\n',encoding='utf-8')
    (out/'envoi-request-gate.patch').write_text(''.join(diff),encoding='utf-8',newline='\n')
    if a.write_fixtures:
        (HERE/'pinned-factory-fixtures.json').write_text(json.dumps({'base':PIN,'files':manifest,'functions':fixtures},indent=2)+'\n',encoding='utf-8')
        (HERE/'native-request-gate.patch').write_text(''.join(diff),encoding='utf-8',newline='\n')
    print(json.dumps({'state':'ISOLATED_NATIVE_PATCH_PREPARED','nativeBase':PIN,'files':len(manifest)+1,'sourceInputChanged':False,'profilesChanged':False,'providerRequests':0}))
if __name__=='__main__':main()
