"""Opt-in, mandatory provider transport for an isolated, single-profile Hermes host.

Installed only by an explicit reviewed native-source adoption, never by importing
this file. Provider credentials stay in the SDK; this module never logs requests.
The physical HTTP request crosses an authenticated loopback meter, whose only
upstream is the unchanged HTTPS Anthropic Messages endpoint.
"""
from __future__ import annotations
import hashlib
import hmac
import http.client
import io
import json
import os
import re
import select
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

UPSTREAM = 'https://api.anthropic.com'
MAX_BODY = 2_000_000
_anchor = None
_lock = threading.RLock()
_native_root=Path(__file__).resolve().parents[1]
_factory_names=('agent/anthropic_adapter.py','agent/agent_init.py','agent/auxiliary_client.py','hermes_cli/runtime_provider.py','tools/tool_search.py','gateway/control_socket.py')
_loaded_module_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
def _factory_sha256():
    try:
        value=[[name,hashlib.sha256((_native_root/name).read_bytes()).hexdigest()] for name in _factory_names]
        return hashlib.sha256(json.dumps(value,separators=(',',':')).encode()).hexdigest()
    except OSError:return None
_loaded_factories_sha256=_factory_sha256()

class RequestGateRefused(RuntimeError):
    def __init__(self, code='PROVIDER_REQUEST_GATE_REFUSED'):
        self.code = code
        super().__init__(code)  # Never interpolate policy, headers, key, prompt or URL.

@dataclass(frozen=True)
class Policy:
    path: str
    digest: str
    window: str
    profile: str
    role: str
    origin: str
    token: str
    models: tuple[str, ...]
    deadline: float
    config_digest: str
    eager_case_tools: bool

    def verify(self):
        try:
            b = Path(self.path).read_bytes()
            if len(b) > 16384 or hashlib.sha256(b).hexdigest() != self.digest:
                raise RequestGateRefused('PROVIDER_GATE_POLICY_CHANGED')
        except RequestGateRefused:
            raise
        except Exception:
            raise RequestGateRefused('PROVIDER_GATE_POLICY_UNAVAILABLE') from None
        if time.time() >= self.deadline:
            raise RequestGateRefused('PROVIDER_GATE_HARD_STOP')
        try:
            if os.path.normcase(os.path.realpath(os.environ['HERMES_HOME']))!=self.profile or hashlib.sha256((Path(self.profile)/'config.yaml').read_bytes()).hexdigest()!=self.config_digest:
                raise ValueError()
        except Exception:
            raise RequestGateRefused('PROVIDER_GATE_PROFILE_CHANGED') from None
        return self

def policy():
    """A successfully armed process cannot downgrade when its environment changes."""
    global _anchor
    with _lock:
        if _anchor is not None:
            return _anchor.verify()
        enabled = os.environ.get('ENVOI_HERMES_GATE_REQUIRED', '')
        if not enabled:
            return None
        if enabled != '1':
            raise RequestGateRefused('PROVIDER_GATE_REQUIRED_INVALID')
        try:
            filename = os.environ['ENVOI_HERMES_GATE_POLICY']
            digest = os.environ['ENVOI_HERMES_GATE_POLICY_SHA256']
            if not Path(filename).is_absolute() or not re.fullmatch('[a-f0-9]{64}', digest):
                raise ValueError()
            b = Path(filename).read_bytes()
            if len(b) > 16384 or hashlib.sha256(b).hexdigest() != digest:
                raise ValueError()
            data = json.loads(b)
            fields = {'version','window','profile','role','origin','token','models','hardStopUnix','upstream','configSha256','eagerCaseTools'}
            if set(data) != fields or data['version'] != 1 or data['upstream'] != UPSTREAM:
                raise ValueError()
            u = urlsplit(data['origin'])
            if u.scheme != 'http' or u.hostname != '127.0.0.1' or not u.port or u.username or u.password or u.query or u.fragment or u.path not in ('','/'):
                raise ValueError()
            if not re.fullmatch('[a-f0-9]{64}', data['token']) or not re.fullmatch('[a-f0-9]{64}', data['window']):
                raise ValueError()
            if data['profile'] != os.path.normcase(os.path.realpath(os.environ['HERMES_HOME'])):
                raise ValueError()
            if data['role'] not in ('je1','je2','testowner'):
                raise ValueError()
            if not re.fullmatch('[a-f0-9]{64}',data['configSha256']):raise ValueError()
            if type(data['eagerCaseTools']) is not bool:raise ValueError()
            if not isinstance(data['models'],list) or not 1 <= len(data['models']) <= 8 or any(not isinstance(m,str) or not re.fullmatch('[A-Za-z0-9_.:/-]{1,160}',m) for m in data['models']):
                raise ValueError()
            if type(data['hardStopUnix']) not in (int,float) or not time.time() < data['hardStopUnix'] <= time.time()+5400:
                raise ValueError()
            _anchor = Policy(filename,digest,data['window'],data['profile'],data['role'],data['origin'].rstrip('/'),data['token'],tuple(data['models']),data['hardStopUnix'],data['configSha256'],data['eagerCaseTools'])
            return _anchor.verify()
        except RequestGateRefused:
            raise
        except Exception:
            raise RequestGateRefused('PROVIDER_GATE_SETUP_INVALID') from None

def guard_provider(provider=None, model=None):
    p = policy()
    if p is None:
        return
    if provider not in (None,'','auto','anthropic'):
        raise RequestGateRefused('PROVIDER_GATE_FOREIGN_PROVIDER')
    if model not in (None,'','auto') and model not in p.models:
        raise RequestGateRefused('PROVIDER_GATE_MODEL_CHANGED')

def pin_endpoint(base_url=None):
    if policy() is None:
        return base_url
    if base_url and str(base_url).rstrip('/') not in (UPSTREAM,UPSTREAM+'/v1'):
        raise RequestGateRefused('PROVIDER_GATE_FOREIGN_ENDPOINT')
    return UPSTREAM

def forbid_variant(code):
    if policy() is not None:
        raise RequestGateRefused(code)

def eager_case_tool(name):
    p=policy()
    return bool(p and p.eager_case_tools and isinstance(name,str) and re.fullmatch(r'mcp__?envoi_turn_[a-f0-9]{16}_[A-Za-z0-9_-]{1,100}',name))

def guard_cached_client(client):
    p=policy()
    if p is None:return
    leaf=getattr(client,'_real_client',client)
    closed=getattr(leaf,'is_closed',False)
    if callable(closed):closed=closed()
    if getattr(leaf,'_envoi_gate_digest',None)!=p.digest or closed:
        raise RequestGateRefused('PROVIDER_GATE_UNGUARDED_CACHE_REFUSED')

def runtime_status(instance_id,challenge):
    """Authenticated owner-control proof, bound to this process and a fresh nonce."""
    if not isinstance(instance_id,str) or not instance_id or not isinstance(challenge,str) or not re.fullmatch('[a-f0-9]{32}',challenge):
        raise RequestGateRefused('PROVIDER_GATE_ATTESTATION_REFUSED')
    p=policy()
    if p is None:return {'version':1,'required':False,'ready':False}
    ready=bool(_loaded_factories_sha256 and _factory_sha256()==_loaded_factories_sha256)
    fields=[1,instance_id,challenge,p.digest,_loaded_module_sha256,_loaded_factories_sha256,
        hashlib.sha256(p.profile.encode()).hexdigest(),p.window,p.role,int(p.deadline*1000),ready]
    mac=hmac.new(bytes.fromhex(p.token),json.dumps(fields,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
    return {'version':1,'required':True,'ready':ready,'fields':fields,'mac':mac}

class CancelableReader(io.RawIOBase):
    def __init__(self,connection):self.connection=connection
    def readable(self):return True
    def readinto(self,buffer):
        conn=self.connection;deadline=min(conn.absolute_deadline,time.monotonic()+conn.read_timeout)
        while True:
            if conn.cancelled.is_set():raise RequestGateRefused('PROVIDER_GATE_CANCELLED')
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('PROVIDER_GATE_READ_TIMEOUT')
            try:
                ready,_,_=select.select([conn.last_socket],[],[],min(.05,remaining))
                if ready:return conn.last_socket.recv_into(buffer)
            except (OSError,ValueError):raise RequestGateRefused('PROVIDER_GATE_CANCELLED') from None

class CancelableSocket:
    def __init__(self,raw,connection):self.raw,self.connection=raw,connection
    def __getattr__(self,name):return getattr(self.raw,name)
    def close(self):pass  # A will-close response owns the raw socket until its body closes.
    def makefile(self,mode='rb',*args,**kwargs):
        if mode!='rb':raise RequestGateRefused('PROVIDER_GATE_STREAM_MODE_REFUSED')
        # No socket.makefile ownership ref can trap cancellation in Windows recv.
        return io.BufferedReader(CancelableReader(self.connection))

class CancelableConnection(http.client.HTTPConnection):
    def __init__(self,*args,write_timeout=None,**kwargs):
        super().__init__(*args,**kwargs);self.cancelled=threading.Event();self.last_socket=None;self.write_timeout=write_timeout;self.read_timeout=120;self.absolute_deadline=time.monotonic()+120
    def connect(self):
        if self.cancelled.is_set():raise RequestGateRefused('PROVIDER_GATE_CANCELLED')
        super().connect();self.last_socket=self.sock;self.sock=CancelableSocket(self.last_socket,self)
        if self.cancelled.is_set():self.cancel();raise RequestGateRefused('PROVIDER_GATE_CANCELLED')
    def send(self,data):
        if self.cancelled.is_set():raise RequestGateRefused('PROVIDER_GATE_CANCELLED')
        if self.sock is not None and self.write_timeout is not None:self.sock.settimeout(self.write_timeout)
        return super().send(data)
    def cancel(self):
        self.cancelled.set()
        for s in (self.sock,self.last_socket):
            if s:
                try:s.shutdown(socket.SHUT_RDWR)
                except OSError:pass
        super().close()
        if self.last_socket:self.last_socket.close()

class ForwardedResponse:
    def __init__(self,conn,response,p,deadline,unregister):
        self.conn,self.response,self.policy = conn,response,p
        self.deadline,self.unregister=deadline,unregister
        self.status = response.status
        self.headers = response.getheaders()
    def chunks(self):
        try:
            while True:
                self.policy.verify()
                remaining=self.deadline-time.monotonic()
                if remaining<=0:raise RequestGateRefused('PROVIDER_GATE_REQUEST_DEADLINE')
                if self.conn.sock:
                    self.conn.sock.settimeout(max(0.001,min(self.read_timeout,remaining)))
                chunk=self.response.read1(65536)
                if not chunk:return
                self.policy.verify()
                yield chunk
        finally:self.close()
    def close(self):
        self.conn.cancel();self.response.close();self.unregister(self.conn)

def native_work_token(p,session_id=None):
    if session_id is None:
        try:
            from agent.relay_runtime import active_turn
            turn=active_turn();session_id=turn.lease.session_id if turn else None
        except Exception:session_id=None
    if not isinstance(session_id,str) or not 1<=len(session_id)<=256:
        raise RequestGateRefused('PROVIDER_GATE_NATIVE_WORK_REQUIRED')
    return hmac.new(bytes.fromhex(p.token),(p.window+'\0'+p.role+'\0'+session_id).encode(),hashlib.sha256).hexdigest()

def forward(method,url,headers,body,p=None,register=lambda _:None,unregister=lambda _:None,timeouts=None,session_id=None):
    p=(p or policy())
    if p is None:raise RequestGateRefused('PROVIDER_GATE_NOT_ARMED')
    p.verify()
    if method!='POST' or str(url)!=UPSTREAM+'/v1/messages':
        raise RequestGateRefused('PROVIDER_GATE_REQUEST_ROUTE_REFUSED')
    if not isinstance(body,bytes) or len(body)>MAX_BODY:
        raise RequestGateRefused('PROVIDER_GATE_BODY_REFUSED')
    try:data=json.loads(body)
    except Exception:raise RequestGateRefused('PROVIDER_GATE_BODY_REFUSED') from None
    if not isinstance(data,dict) or data.get('model') not in p.models or not isinstance(data.get('messages'),list):
        raise RequestGateRefused('PROVIDER_GATE_MODEL_CHANGED')
    h={str(k).lower():str(v) for k,v in headers.items()}
    if h.get('host','api.anthropic.com')!='api.anthropic.com':
        raise RequestGateRefused('PROVIDER_GATE_HOST_OVERRIDE')
    if h.get('content-encoding','identity')!='identity':raise RequestGateRefused('PROVIDER_GATE_ENCODING_REFUSED')
    nominated={x.strip().lower() for x in h.get('connection','').split(',') if x.strip()}
    if nominated-{'keep-alive','close'}:raise RequestGateRefused('PROVIDER_GATE_FRAMING_REFUSED')
    for key in ('host','content-length','connection','transfer-encoding','te','trailer','upgrade','keep-alive','proxy-authenticate','proxy-authorization','x-phase-c-meter','x-envoi-meter-role','x-envoi-meter-window','x-envoi-meter-work'):
        h.pop(key,None)
    h.update({'x-phase-c-meter':p.token,'x-envoi-meter-role':p.role,'x-envoi-meter-window':p.window,'x-envoi-meter-work':native_work_token(p,session_id)})
    u=urlsplit(p.origin)
    deadline=time.monotonic()+min(120,p.deadline-time.time())
    limits={}
    for key in ('connect','read','write','pool'):
        value=(timeouts or {}).get(key)
        if value is not None and (type(value) not in (int,float) or value<=0):raise RequestGateRefused('PROVIDER_GATE_TIMEOUT_INVALID')
        limits[key]=max(.001,min(value if value is not None else 120,deadline-time.monotonic()))
    conn=CancelableConnection(u.hostname,u.port,timeout=limits['connect'],write_timeout=limits['write'])
    conn.absolute_deadline=deadline;conn.read_timeout=limits['read']
    try:
        register(conn)
        p.verify();conn.request('POST','/v1/messages',body=body,headers=h)
        if conn.sock:conn.sock.settimeout(min(limits['read'],max(.001,deadline-time.monotonic())))
        response=conn.getresponse()
        if 300<=response.status<400:
            response.close();raise RequestGateRefused('PROVIDER_GATE_REDIRECT_REFUSED')
        result=ForwardedResponse(conn,response,p,deadline,unregister);result.read_timeout=limits['read'];return result
    except RequestGateRefused:
        conn.cancel();unregister(conn);raise
    except Exception:
        conn.cancel();unregister(conn);raise RequestGateRefused('PROVIDER_GATE_TRANSPORT_UNAVAILABLE') from None

def construct_client(sdk,kwargs,session_id=None):
    """Guard constructor AND SDK copy/with_options; transport is never caller-replaceable."""
    p=policy()
    if p is None:return sdk.Anthropic(**kwargs)
    import httpx
    class Body(httpx.SyncByteStream):
        def __init__(self,response):self.response=response
        def __iter__(self):yield from self.response.chunks()
        def close(self):self.response.close()
    class Transport(httpx.BaseTransport):
        def __init__(self):self.lock=threading.RLock();self.connections=set();self.closed=False
        def register(self,conn):
            with self.lock:
                if self.closed:raise RequestGateRefused('PROVIDER_GATE_CLIENT_CLOSED')
                self.connections.add(conn)
        def unregister(self,conn):
            with self.lock:self.connections.discard(conn)
        def handle_request(self,request):
            response=forward(request.method,str(request.url),dict(request.headers),request.read(),p,self.register,self.unregister,request.extensions.get('timeout'),session_id)
            return httpx.Response(response.status,headers=response.headers,stream=Body(response),request=request)
        def close(self):
            with self.lock:
                self.closed=True
                for conn in tuple(self.connections):conn.cancel()
                self.connections.clear()
    class Client(sdk.Anthropic):
        def __init__(self,*args,**options):
            p.verify()
            if args:raise RequestGateRefused('PROVIDER_GATE_CLIENT_OVERRIDE')
            pin_endpoint(options.get('base_url'))
            prior=options.get('http_client')
            if prior is not None and getattr(prior,'_envoi_gate_digest',None)!=p.digest:
                raise RequestGateRefused('PROVIDER_GATE_CLIENT_OVERRIDE')
            if options.get('max_retries',0)!=0:
                raise RequestGateRefused('PROVIDER_GATE_RETRY_OVERRIDE')
            client=httpx.Client(transport=Transport(),follow_redirects=False,trust_env=False)
            client._envoi_gate_digest=p.digest
            options.update(http_client=client,base_url=UPSTREAM,max_retries=0)
            try:super().__init__(**options)
            except BaseException:client.close();raise
            self._envoi_gate_digest=p.digest
    return Client(**kwargs)
