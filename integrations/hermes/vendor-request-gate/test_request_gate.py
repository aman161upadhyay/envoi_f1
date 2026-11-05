"""Inert pinned native/transport tests. --sdk additionally requires real httpx/anthropic.
Only disposable temporary profiles and authenticated loopback HTTP are used.
"""
import ast, asyncio, hashlib, hmac, importlib.util, json, os, socket, sys, tempfile, threading, time, types, unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
RUN_SDK='--sdk' in sys.argv
if RUN_SDK:sys.argv.remove('--sdk')

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args):pass
    def do_POST(self):
        self.close_connection=True
        b=self.rfile.read(int(self.headers.get('content-length','0')))
        expected=hmac.new(bytes.fromhex('b'*64),('a'*64+'\0je1\0native_inert_session').encode(),hashlib.sha256).hexdigest()
        if (self.headers.get('x-phase-c-meter'),self.headers.get('x-envoi-meter-role'),self.headers.get('x-envoi-meter-window'),self.headers.get('x-envoi-meter-work'))!=('b'*64,'je1','a'*64,expected):
            self.send_response(403);self.send_header('Content-Length','0');self.end_headers();return
        with open(self.server.charge_file,'ab') as ledger:
            ledger.write(b'charged\n');ledger.flush();os.fsync(ledger.fileno())
        self.server.requests.append((self.path,dict(self.headers),b));self.server.arrived.set()
        try:
            if self.server.mode=='wait_headers':self.server.release.wait(3)
            if self.server.mode=='slow_headers':time.sleep(1.15)
            response={'id':'msg_inert','type':'message','role':'assistant','model':'inert-model','content':[{'type':'text','text':'ok'}],'stop_reason':'end_turn','usage':{'input_tokens':1,'output_tokens':1}}
            payload=json.dumps(response).encode()
            status=302 if self.server.mode=='redirect' else 200
            if self.server.mode in ('sse','wait_sse'):
                frames=[{'type':'message_start','message':{**response,'content':[],'stop_reason':None}},{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}},{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'ok'}},{'type':'content_block_stop','index':0},{'type':'message_delta','delta':{'stop_reason':'end_turn'},'usage':{'output_tokens':1}},{'type':'message_stop'}]
                parts=[('event: '+f['type']+'\ndata: '+json.dumps(f)+'\n\n').encode() for f in frames]
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(sum(map(len,parts))));self.end_headers();self.wfile.write(parts[0]);self.wfile.flush()
                if self.server.mode=='wait_sse':self.server.release.wait(3)
                else:time.sleep(1.15)
                for part in parts[1:]:self.wfile.write(part);self.wfile.flush()
                return
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers()
            if self.server.mode=='slow_body':time.sleep(1.15)
            if self.server.mode=='wait_body':self.server.release.wait(3)
            self.wfile.write(payload);self.wfile.flush()
        except (OSError,ValueError):pass

class Base(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.profile=self.root/'profile';self.profile.mkdir();(self.profile/'config.yaml').write_text('model: inert\n')
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True;self.server.requests=[];self.server.mode='normal';self.server.arrived=threading.Event();self.server.release=threading.Event()
        self.server.charge_file=self.root/'mock-bound-charges.log'
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.file=self.root/'policy.json';self.policy_data={'version':1,'window':'a'*64,'profile':os.path.normcase(os.path.realpath(self.profile)),'role':'je1','origin':'http://127.0.0.1:'+str(self.server.server_port),'token':'b'*64,'models':['inert-model'],'hardStopUnix':time.time()+60,'upstream':'https://api.anthropic.com','configSha256':hashlib.sha256((self.profile/'config.yaml').read_bytes()).hexdigest(),'eagerCaseTools':False}
        self.save_policy()
        self.env=patch.dict(os.environ,{'ANTHROPIC_API_KEY':'','ANTHROPIC_AUTH_TOKEN':'','ANTHROPIC_BASE_URL':'','HERMES_HOME':str(self.profile),'ENVOI_HERMES_GATE_REQUIRED':'1','ENVOI_HERMES_GATE_POLICY':str(self.file),'ENVOI_HERMES_GATE_POLICY_SHA256':hashlib.sha256(self.file.read_bytes()).hexdigest()});self.env.start()
        spec=importlib.util.spec_from_file_location('envoi_gate_test_'+str(id(self)),HERE/'envoi_request_gate.py');self.gate=importlib.util.module_from_spec(spec);sys.modules[spec.name]=self.gate;spec.loader.exec_module(self.gate)
        self.module_name=spec.name
    def save_policy(self):self.file.write_text(json.dumps(self.policy_data),encoding='utf-8')
    def tearDown(self):
        self.server.release.set();self.server.shutdown();self.server.server_close();self.env.stop();sys.modules.pop(self.module_name,None);self.temp.cleanup()
    def body(self):return json.dumps({'model':'inert-model','messages':[]}).encode()
    def forward(self,*args,**kwargs):return self.gate.forward(*args,session_id='native_inert_session',**kwargs)
    def factory(self,file,name,extra=None):
        fixtures=json.loads((HERE/'pinned-factory-fixtures.json').read_text())
        text='from __future__ import annotations\n'+fixtures['functions'][file][name]
        ns={};ns.update(extra or {});exec(compile(text,file,'exec'),ns);return ns[name]
    def construct_native_agent(self,builder,session_id='native_inert_session'):
        """Execute the pinned constructor, client phases and real session initializer.

        Unrelated tool/memory/display setup is inert; constructor ordering and
        session creation are the upstream code, not a pre-populated mock agent.
        """
        from contextlib import suppress
        from datetime import datetime
        snippets=json.loads((HERE/'pinned-factory-fixtures.json').read_text())['functions']['agent/agent_init.py']
        agent=types.SimpleNamespace(_read_reasoning_echo_from_config=lambda:False)
        events=[]
        ns={name:lambda *a,**k:None for name in (
            '_install_safe_stdio','_finalize_routing','_set_defaults','_init_prompt_cache_config',
            '_init_turn_state','_setup_logging','_init_fallback_chain','_load_tools',
            '_apply_display_config','_init_memory','_apply_agent_section','_build_context_engine',
            '_configure_ollama_num_ctx','_enforce_minimum_context','_warn_nonagentic_hermes_model',
            '_inject_context_engine_tools','_init_usage_state','_clamp_compressor_to_ollama_num_ctx',
            '_emit_compression_summary','_snapshot_primary_runtime')}
        ns.update({'_PASSTHROUGH_PARAMS':['model','quiet_mode','max_iterations'],
            '_GATEWAY_IDENTITY_PARAMS':[],'_CALLBACK_PARAMS':[],
            '_CONTROL_STATE':{},'_STREAM_STATE':{},'_SESSION_STATE':{},
            'IterationBudget':lambda *a:object(),
            '_resolve_api_mode':lambda a,*args:setattr(a,'api_mode','anthropic_messages'),
            'get_provider_request_timeout':lambda *a:2,
            '_parse_compression_config':lambda *a:None,
            '_resolve_context_length':lambda *a:(None,None,None,{}),
            'datetime':datetime,'sys':sys,'new_session_id':lambda *a:'native_inert_session',
            '_publish_session_id':lambda sid:events.append(('session-initialized',sid)),
            'get_hermes_home':lambda:self.profile,'suppress':suppress})
        text='from __future__ import annotations\n'+'\n\n'.join(snippets[n] for n in
            ('init_agent','_build_client','_init_anthropic_client','_init_session_state'))
        exec(compile(text,'pinned-agent-init','exec'),ns)
        def module(name,**values):
            m=types.ModuleType(name);m.__dict__.update(values);return m
        def build(*a,**kw):
            events.append(('client-constructed',hasattr(agent,'session_id')))
            return builder(*a,**kw)
        modules={
            'agent.safe_worker_policy':module('agent.safe_worker_policy',safe_worker_enabled=lambda:False),
            'hermes_cli.providers':module('hermes_cli.providers',is_actual_route=lambda *a:False),
            'hermes_cli.config':module('hermes_cli.config',load_config_readonly=lambda:{}),
            'agent.anthropic_adapter':module('agent.anthropic_adapter',build_anthropic_client=build),
            'agent.anthropic_credentials':module('agent.anthropic_credentials',
                resolve_anthropic_token=lambda:'inert-sentinel-not-real-key',anthropic_route_is_oauth=lambda *a,**k:False),
            'tools.checkpoint_manager':module('tools.checkpoint_manager',CheckpointManager=lambda **kw:object()),
            'tools.todo_tool':module('tools.todo_tool',TodoStore=lambda:object()),
        }
        with self.native_module(modules):
            ns['init_agent'](agent,model='inert-model',provider='anthropic',
                api_key='inert-sentinel-not-real-key',base_url='https://api.anthropic.com',
                quiet_mode=True,session_id=session_id)
        self.assertEqual(events,[('client-constructed',False),('session-initialized','native_inert_session')])
        return agent
    @contextmanager
    def native_module(self,extra=None):
        values={'agent.envoi_request_gate':self.gate};values.update(extra or {});before={k:sys.modules.get(k) for k in values};sys.modules.update(values)
        try:yield
        finally:
            for k,v in before.items():
                if v is None:sys.modules.pop(k,None)
                else:sys.modules[k]=v

class CoreTests(Base):
    def test_actual_constructor_binds_the_later_session_without_preexisting_identity(self):
        for sid in ('native_inert_session',None):
            with self.subTest(explicit_session=sid):
                agent=self.construct_native_agent(lambda *a,**kw:types.SimpleNamespace(source=kw['gate_session_id']),sid)
                self.assertEqual(agent.session_id,'native_inert_session')
                self.assertTrue(callable(agent._anthropic_client.source))
                self.assertEqual(agent._anthropic_client.source(),agent.session_id)
        self.assertEqual(self.server.requests,[])
    def test_deferred_missing_identity_cannot_fall_back_to_another_active_turn(self):
        relay=types.ModuleType('agent.relay_runtime')
        relay.active_turn=lambda:types.SimpleNamespace(lease=types.SimpleNamespace(session_id='native_inert_session'))
        with self.native_module({'agent.relay_runtime':relay}):
            for source in (lambda:None,lambda:'',lambda:123,lambda:(_ for _ in ()).throw(AttributeError('uninitialized'))):
                with self.subTest(source=source),self.assertRaises(self.gate.RequestGateRefused) as error:
                    self.gate.native_work_token(self.gate.policy(),source)
                self.assertEqual(error.exception.code,'PROVIDER_GATE_NATIVE_WORK_REQUIRED')
        self.assertEqual(self.server.requests,[])
    def test_loaded_instance_attestation_requires_patched_files_policy_and_fresh_nonce(self):
        native=self.root/'isolated-native';agent=native/'agent';agent.mkdir(parents=True)
        for name in self.gate._factory_names:
            file=native/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('# inert native fixture\n')
        target=agent/'envoi_request_gate.py';target.write_bytes((HERE/'envoi_request_gate.py').read_bytes())
        spec=importlib.util.spec_from_file_location('isolated_gate_attestation',target);gate=importlib.util.module_from_spec(spec);sys.modules[spec.name]=gate
        try:
            spec.loader.exec_module(gate)
            p=gate.runtime_status('inert-instance','1'*32);self.assertTrue(p['ready'])
            self.assertEqual(p['fields'][1:3],['inert-instance','1'*32])
            self.assertEqual(p['mac'],hmac.new(bytes.fromhex('b'*64),json.dumps(p['fields'],separators=(',',':')).encode(),hashlib.sha256).hexdigest())
            self.assertNotEqual(p['mac'],gate.runtime_status('inert-instance','2'*32)['mac'])
            self.assertNotEqual(p['mac'],gate.runtime_status('replacement-instance','1'*32)['mac'])
            (native/'agent/auxiliary_client.py').write_text('# changed after load\n')
            self.assertFalse(gate.runtime_status('inert-instance','1'*32)['ready'])
            with self.assertRaises(gate.RequestGateRefused):gate.runtime_status('inert-instance','bad')
            self.file.unlink()
            with self.assertRaises(gate.RequestGateRefused):gate.runtime_status('inert-instance','1'*32)
            self.assertEqual(len(self.server.requests),0)
        finally:sys.modules.pop(spec.name,None)
    def test_unset_mode_keeps_unrelated_runtime_unchanged(self):
        os.environ.pop('ENVOI_HERMES_GATE_REQUIRED');self.assertIsNone(self.gate.policy());self.assertEqual(self.gate.pin_endpoint('https://other.invalid'),'https://other.invalid')
    def test_policy_cannot_downgrade_after_first_arm(self):
        self.gate.policy();os.environ.pop('ENVOI_HERMES_GATE_REQUIRED');self.assertIsNotNone(self.gate.policy())
    def test_policy_and_profile_changes_refuse_before_network(self):
        self.gate.policy();(self.profile/'config.yaml').write_text('changed')
        with self.assertRaises(self.gate.RequestGateRefused):self.gate.forward('POST','https://api.anthropic.com/v1/messages',{},self.body())
        self.assertEqual(len(self.server.requests),0)
    def test_missing_required_policy_refuses(self):
        self.file.unlink()
        with self.assertRaises(self.gate.RequestGateRefused):self.gate.policy()
    def test_plain_transport_preserves_body_and_uses_bound_meter(self):
        response=self.forward('POST','https://api.anthropic.com/v1/messages',{'content-type':'application/json','x-api-key':'inert-sentinel'},self.body());data=b''.join(response.chunks())
        self.assertEqual(json.loads(data)['content'][0]['text'],'ok');self.assertEqual(self.server.requests[0][2],self.body());self.assertEqual(self.server.requests[0][1]['x-phase-c-meter'],'b'*64)
    def test_foreign_route_host_model_and_framing_never_forward(self):
        checks=[('https://other.invalid/v1/messages',{},self.body()),('https://api.anthropic.com/v1/messages',{'Host':'other.invalid'},self.body()),('https://api.anthropic.com/v1/messages',{},b'{"model":"other","messages":[]}'),('https://api.anthropic.com/v1/messages',{'Connection':'X-Api-Key'},self.body())]
        for url,headers,body in checks:
            with self.subTest(url=url,headers=headers):
                with self.assertRaises(self.gate.RequestGateRefused):self.gate.forward('POST',url,headers,body)
        self.assertEqual(len(self.server.requests),0)
    def test_transfer_encoding_is_removed_for_buffered_body(self):
        r=self.forward('POST','https://api.anthropic.com/v1/messages',{'Transfer-Encoding':'chunked','TE':'trailers','Trailer':'x-test'},self.body());list(r.chunks())
        headers={k.lower():v for k,v in self.server.requests[0][1].items()};self.assertNotIn('transfer-encoding',headers);self.assertNotIn('te',headers);self.assertEqual(int(headers['content-length']),len(self.body()))
    def test_redirect_is_not_followed(self):
        self.server.mode='redirect'
        with self.assertRaises(self.gate.RequestGateRefused):self.forward('POST','https://api.anthropic.com/v1/messages',{},self.body())
        self.assertEqual(len(self.server.requests),1)
    def test_eager_presentation_only_changes_selected_mcp_classification(self):
        self.policy_data['eagerCaseTools']=True;self.save_policy();os.environ['ENVOI_HERMES_GATE_POLICY_SHA256']=hashlib.sha256(self.file.read_bytes()).hexdigest()
        wanted='mcp_envoi_turn_0123456789abcdef_reply';other='mcp_foreign_reply';definitions=[{'function':{'name':wanted,'parameters':{'type':'object'}}},{'function':{'name':other,'parameters':{'type':'object'}}}]
        fn=self.factory('tools/tool_search.py','classify_tools',{'BRIDGE_TOOL_NAMES':set(),'_tool_def_names':lambda defs:[d['function']['name'] for d in defs],'is_deferrable_tool_name':lambda *_:True})
        with self.native_module():visible,deferred=fn(definitions,set())
        self.assertEqual(visible,[definitions[0]]);self.assertIs(visible[0],definitions[0]);self.assertEqual(deferred,[definitions[1]])
    def test_foreign_direct_constructors_refuse_before_import_or_credential_network(self):
        names=['_try_openrouter','_try_nous','_try_custom_endpoint','_build_xai_oauth_aux_client','_build_codex_client','_try_azure_foundry','_build_bedrock_client','_build_vertex_client','_resolve_external_process_branch']
        import inspect
        with self.native_module():
            for name in names:
                fn=self.factory('agent/auxiliary_client.py',name);args={}
                for p in inspect.signature(fn).parameters.values():
                    if p.default is inspect.Parameter.empty and p.kind not in (p.VAR_KEYWORD,p.VAR_POSITIONAL):args[p.name]='inert'
                with self.subTest(name=name),self.assertRaises(self.gate.RequestGateRefused):fn(**args)
        self.assertEqual(len(self.server.requests),0)
    def test_foreign_vision_and_cache_entry_denied(self):
        with self.native_module():
            for name in ('resolve_vision_provider_client','_resolve_strict_vision_backend','_get_cached_client','resolve_provider_client'):
                with self.subTest(name=name),self.assertRaises(self.gate.RequestGateRefused):self.factory('agent/auxiliary_client.py',name)(provider='vertex',model='inert-model')
        self.assertEqual(len(self.server.requests),0)
    def test_unguarded_cached_client_and_async_conversion_denied(self):
        with self.assertRaises(self.gate.RequestGateRefused):self.gate.guard_cached_client(types.SimpleNamespace())
        with self.native_module(),self.assertRaises(self.gate.RequestGateRefused):self.factory('agent/auxiliary_client.py','_to_async_client',{'_AuxProbeClientStub':type('Probe',(),{})})(types.SimpleNamespace(),'inert-model')
    def test_native_runtime_rejects_foreign_provider_and_endpoint(self):
        fn=self.factory('hermes_cli/runtime_provider.py','_runtime')
        with self.native_module():
            for provider,url in [('vertex','https://api.anthropic.com'),('anthropic','https://foreign.invalid')]:
                with self.assertRaises(self.gate.RequestGateRefused):fn(provider,'anthropic_messages',url,'inert-sentinel')

if RUN_SDK:
    import anthropic, httpx
    class SDKTests(Base):
        def setUp(self):
            super().setUp()
            block=patch.object(httpx.HTTPTransport,'handle_request',side_effect=AssertionError('UNMETERED_HTTPX_IO_REFUSED_BY_TEST'))
            block.start();self.addCleanup(block.stop)
        def client(self):return self.gate.construct_client(anthropic,{'api_key':'inert-sentinel-not-real-key','max_retries':0},session_id='native_inert_session')
        def request(self,client,**kwargs):return client.messages.create(model='inert-model',max_tokens=10,messages=[{'role':'user','content':'inert'}],**kwargs)
        def test_actual_constructor_and_sdk_rebuild_dispatch_with_the_initialized_identity(self):
            def build(key,url,**kw):
                return self.gate.construct_client(anthropic,{'api_key':key,'base_url':url,'max_retries':0},kw['gate_session_id'])
            for sid in ('native_inert_session',None):
                with self.subTest(explicit_session=sid):
                    agent=self.construct_native_agent(build,sid)
                    with agent._anthropic_client as client:
                        self.assertEqual(self.request(client).content[0].text,'ok')
                        with client.with_options(timeout=2) as rebuilt:
                            self.assertEqual(self.request(rebuilt).content[0].text,'ok')
            self.assertEqual(len(self.server.requests),4)
            self.assertEqual(self.server.charge_file.read_bytes(),b'charged\n'*4)
        def test_actual_constructor_missing_or_mismatched_later_identity_never_charges(self):
            def build(key,url,**kw):
                return self.gate.construct_client(anthropic,{'api_key':key,'base_url':url,'max_retries':0},kw['gate_session_id'])
            agent=self.construct_native_agent(build)
            with agent._anthropic_client as client:
                del agent.session_id
                with self.assertRaises(anthropic.APIConnectionError) as error:self.request(client)
                self.assertIsInstance(error.exception.__cause__,self.gate.RequestGateRefused)
                self.assertEqual(error.exception.__cause__.code,'PROVIDER_GATE_NATIVE_WORK_REQUIRED')
                agent.session_id='different-native-session'
                with self.assertRaises(anthropic.PermissionDeniedError):self.request(client)
            self.assertEqual(self.server.requests,[])
            self.assertFalse(self.server.charge_file.exists())
        def test_real_sdk_normal_and_rebuilt_client_use_meter(self):
            with self.client() as client:
                self.assertEqual(self.request(client).content[0].text,'ok')
                with client.with_options(timeout=5) as rebuilt:self.assertEqual(self.request(rebuilt).content[0].text,'ok')
            self.assertEqual(len(self.server.requests),2)
        def test_real_sdk_foreign_url_custom_http_client_retry_override_refused(self):
            with self.client() as client:
                for changes in ({'base_url':'https://foreign.invalid'},{'max_retries':2},{'http_client':httpx.Client(transport=httpx.MockTransport(lambda _:None))}):
                    with self.subTest(changes=list(changes)),self.assertRaises(self.gate.RequestGateRefused):client.with_options(**changes)
                    if 'http_client' in changes:changes['http_client'].close()
            self.assertEqual(len(self.server.requests),0)
        def test_headers_and_body_can_be_delayed_past_one_second(self):
            for mode in ('slow_headers','slow_body'):
                self.server.mode=mode
                with self.client() as client:self.assertEqual(self.request(client).content[0].text,'ok')
            self.assertEqual(len(self.server.requests),2)
        def test_shorter_rebuilt_sdk_timeout_is_honored(self):
            self.server.mode='slow_headers';started=time.monotonic()
            with self.client() as original,original.with_options(timeout=.05) as client:
                with self.assertRaises(anthropic.APIConnectionError):self.request(client)
            self.assertLess(time.monotonic()-started,.8);self.assertEqual(len(self.server.requests),1)
        def test_client_close_cancels_pending_headers(self):
            self.server.mode='wait_headers';client=self.client();errors=[]
            def run():
                try:self.request(client)
                except Exception as e:errors.append(type(e).__name__)
            thread=threading.Thread(target=run);thread.start();self.assertTrue(self.server.arrived.wait(2));client.close();thread.join(1)
            if thread.is_alive():
                import traceback
                traceback.print_stack(sys._current_frames()[thread.ident])
            self.assertFalse(thread.is_alive());self.assertTrue(errors);self.assertEqual(len(self.server.requests),1)
        def test_client_close_cancels_pending_body(self):
            self.server.mode='wait_body';client=self.client();errors=[]
            def run():
                try:self.request(client)
                except Exception as e:errors.append(type(e).__name__)
            thread=threading.Thread(target=run);thread.start();self.assertTrue(self.server.arrived.wait(2));time.sleep(.05);client.close();thread.join(1)
            self.assertFalse(thread.is_alive());self.assertTrue(errors)
        def test_hard_stop_aborts_pending_response(self):
            self.policy_data['hardStopUnix']=time.time()+.2;self.save_policy();os.environ['ENVOI_HERMES_GATE_POLICY_SHA256']=hashlib.sha256(self.file.read_bytes()).hexdigest();self.server.mode='wait_body'
            started=time.monotonic()
            with self.client() as client:
                with self.assertRaises(Exception):self.request(client)
            self.assertLess(time.monotonic()-started,1);self.assertEqual(len(self.server.requests),1)
        def test_async_threaded_native_auxiliary_path_uses_same_transport(self):
            with self.client() as client:result=asyncio.run(asyncio.to_thread(self.request,client))
            self.assertEqual(result.content[0].text,'ok');self.assertEqual(len(self.server.requests),1)
        def test_exact_native_async_factory_wraps_guarded_cached_sdk_leaf(self):
            snippets=json.loads((HERE/'pinned-factory-fixtures.json').read_text())['functions']['agent/auxiliary_client.py']
            class SyncWrapper:
                def __init__(wrapper,client):
                    wrapper._real_client=client;wrapper.api_key=client.api_key;wrapper.base_url=client.base_url
                    wrapper.chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=lambda **kw:self.request(client,**kw)))
            fake_openai=types.ModuleType('openai');fake_openai.AsyncOpenAI=lambda **kw:(_ for _ in ()).throw(AssertionError('foreign async rebuild'))
            ns={'_ChatShim':lambda completions:types.SimpleNamespace(completions=completions),'_AuxProbeClientStub':type('Probe',(),{}),
                'CodexAuxiliaryClient':type('Codex',(),{}),'AnthropicAuxiliaryClient':SyncWrapper}
            for name in ('_AsyncCompletionsAdapter','_AsyncAuxiliaryClientBase','AsyncAnthropicAuxiliaryClient','_to_async_client'):
                exec(compile('from __future__ import annotations\n'+snippets[name],name,'exec'),ns)
            with self.client() as client,self.native_module({'openai':fake_openai}):
                sync=SyncWrapper(client);self.gate.guard_cached_client(sync)
                converted,model=ns['_to_async_client'](sync,'inert-model');self.assertIs(converted._real_client,client)
                result=asyncio.run(converted.chat.completions.create());self.assertEqual(result.content[0].text,'ok')
                self.server.mode='sse';stream=asyncio.run(converted.chat.completions.create(stream=True));self.assertEqual(list(stream)[-1].type,'message_stop');stream.close()
            self.assertEqual(len(self.server.requests),2)
            with self.native_module({'openai':fake_openai}),self.assertRaises(self.gate.RequestGateRefused):ns['_to_async_client'](sync,'inert-model')
        def test_exact_native_cache_hit_keeps_guarded_sdk_and_refuses_old_cached_leaf(self):
            local=types.ModuleType('agent.auxiliary_local_runtime');local.bare_llamacpp_endpoint=lambda *a:None
            cache={};loop=types.SimpleNamespace(is_closed=lambda:False)
            fn=self.factory('agent/auxiliary_client.py','_get_cached_client',{'_current_event_loop':lambda:loop,'_normalize_main_runtime':lambda _: {},
                '_client_cache_key':lambda *a,**kw:'bound','_client_cache_lock':threading.RLock(),'_client_cache':cache,
                '_compat_model':lambda client,model,default:model or default})
            with self.client() as client,self.native_module({'agent.auxiliary_local_runtime':local}):
                wrapper=types.SimpleNamespace(_real_client=client);cache['bound']=(wrapper,'inert-model',loop)
                for mode in (False,True):
                    hit,model=fn('anthropic','inert-model',async_mode=mode);self.assertIs(hit,wrapper);self.assertEqual(self.request(hit._real_client).content[0].text,'ok')
                cache['bound']=(types.SimpleNamespace(_real_client=types.SimpleNamespace()),'inert-model',loop)
                with self.assertRaises(self.gate.RequestGateRefused):fn('anthropic','inert-model')
            self.assertEqual(len(self.server.requests),2)
        def test_real_sdk_sse_consumption_honors_delayed_tokens(self):
            self.server.mode='sse'
            with self.client() as client:
                with self.request(client,stream=True) as stream:events=list(stream)
            self.assertEqual(''.join(e.delta.text for e in events if e.type=='content_block_delta'),'ok');self.assertEqual(len(self.server.requests),1)
        def test_real_sdk_close_during_sse_stops_stream(self):
            self.server.mode='wait_sse';client=self.client();stream=self.request(client,stream=True);iterator=iter(stream)
            self.assertEqual(next(iterator).type,'message_start');client.close()
            with self.assertRaises(Exception):next(iterator)
            stream.close();self.assertEqual(len(self.server.requests),1)
        def test_exact_config_failure_factory_to_real_sdk_is_metered_once(self):
            import contextlib
            adapter=types.ModuleType('agent.anthropic_adapter');adapter.build_anthropic_client=lambda key,base_url,**kw:self.gate.construct_client(anthropic,{'api_key':key,'base_url':base_url,'max_retries':0},session_id=kw.get('gate_session_id'))
            credentials=types.ModuleType('agent.anthropic_credentials');credentials.resolve_anthropic_token=lambda:'inert-sentinel-not-real-key';credentials._is_oauth_token=lambda _:False
            config=types.ModuleType('hermes_cli.config')
            def unavailable():raise OSError('inert config-read failure')
            config.load_config_readonly=unavailable
            wrapper=lambda client,*args,**kwargs:types.SimpleNamespace(_real_client=client)
            fn=self.factory('agent/auxiliary_client.py','_try_anthropic',{'contextlib':contextlib,'_select_pool_entry':lambda *_:(False,None),'_ANTHROPIC_DEFAULT_BASE_URL':'https://api.anthropic.com','_get_aux_model_for_provider':lambda _:'inert-model','_aux_probe_active':lambda:False,'logger':types.SimpleNamespace(debug=lambda *a,**k:None),'_normalize_main_runtime':lambda _:{'session_id':'native_inert_session'},'AnthropicAuxiliaryClient':wrapper})
            with self.native_module({'agent.anthropic_adapter':adapter,'agent.anthropic_credentials':credentials,'hermes_cli.config':config}):client,_=fn()
            with client._real_client as actual:self.assertEqual(self.request(actual).content[0].text,'ok')
            self.assertEqual(len(self.server.requests),1);self.assertEqual(self.server.charge_file.read_bytes(),b'charged\n')
        def test_pinned_native_builder_preserves_api_key_and_oauth_omit_headers(self):
            fn=self.factory('agent/anthropic_adapter.py','_new_sdk_client',{'_custom_provider_extra_headers':lambda _: {}})
            with self.native_module():
                for kwargs,headers,expected,absent in [({'api_key':'inert-api-key','max_retries':0},{},'x-api-key','authorization'),({'auth_token':'inert-oauth-token','max_retries':0},{'x-app':'cli','user-agent':'claude-code/inert','anthropic-beta':'inert-beta'},'authorization','x-api-key')]:
                    with fn(anthropic,kwargs,headers,route='https://api.anthropic.com',gate_session_id='native_inert_session') as client:self.request(client)
                    sent={k.lower():v for k,v in self.server.requests[-1][1].items()}
                    self.assertIn(expected,sent);self.assertNotIn(absent,sent)
                    if expected=='authorization':self.assertEqual(sent['x-app'],'cli');self.assertEqual(sent['anthropic-beta'],'inert-beta')

if __name__=='__main__':unittest.main(verbosity=2)
