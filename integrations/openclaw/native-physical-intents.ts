import {createHash} from 'node:crypto';
import {assertOwnedClosedNativeAuthority,assertAuthenticatedNativePhysicalIntent,type OwnedClosedNativeAuthority,type OwnedClosedNativePins} from './owned-native-process';
type Intent={id:string;bodySha256:string;proxyOrigin:string;consumed:boolean;nativeStage:string;proxyStage:string;reservationId?:string};
/** Out-of-band native provenance tickets. This object never reserves or finishes budget. */
export class NativePhysicalIntents{
 private intents=new Map<string,Intent>();
 constructor(private readonly authority:OwnedClosedNativeAuthority,private readonly pins:Readonly<OwnedClosedNativePins>,private readonly proxyOrigin:string,private readonly signal:AbortSignal,private readonly assertLive:()=>void,private readonly meter?:Readonly<{nativeToken:string;deadlineUnixMs:number}>){this.meter=meter&&Object.freeze({...meter});}
 private live(){assertOwnedClosedNativeAuthority(this.authority,this.pins,this.signal);this.assertLive();}
 authorizePhysical(row:Readonly<Record<string,unknown>>){this.live();assertAuthenticatedNativePhysicalIntent(row,this.authority);if(row.kind!=='actual_native_physical_dispatch'||['window','workId','caseId','caseSessionId','toolChannelSha256','processIdentity'].some(k=>row[k]!==this.pins[k as keyof OwnedClosedNativePins])
  ||row.requestOrigin!==this.proxyOrigin||row.requestPath!=='/v1/messages'||typeof row.intentId!=='string'||!/^[a-f0-9]{64}$/.test(row.intentId)||typeof row.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(row.bodySha256)||this.intents.has(row.intentId))throw Error('EXACT_NATIVE_PHYSICAL_INTENT_REQUIRED');
  this.intents.set(row.intentId,{id:row.intentId,bodySha256:row.bodySha256,proxyOrigin:this.proxyOrigin,consumed:false,nativeStage:'authorized',proxyStage:'unconsumed'});
 }
 /** Call inside the exact owned proxy AFTER its private auth, BEFORE the sole meter reserve. */
 private consume(bodyHash:string){this.live();const intent=[...this.intents.values()].find(i=>!i.consumed&&i.nativeStage==='authorized'&&i.bodySha256===bodyHash);
  if(!intent)throw Error('OWNED_NATIVE_BODY_INTENT_REQUIRED');intent.consumed=true;intent.proxyStage='admitted';return Object.freeze({intentId:intent.id,bodySha256:intent.bodySha256,workId:this.pins.workId,processIdentity:this.pins.processIdentity});
 }
 takeForProxy(body:Uint8Array){return this.consume(createHash('sha256').update(body).digest('hex'));}
 /** Exact callback shape consumed by the existing sole requestBudgetMeter. */
 takeForMeter(input:Readonly<{role:string;nativeToken:string;window:string;bodySha256:string;deadlineUnixMs:number}>,signal:AbortSignal){signal.throwIfAborted();
  if(!this.meter||input.role!=='openclaw'||input.window!==this.pins.window||input.nativeToken!==this.meter.nativeToken||input.deadlineUnixMs!==this.meter.deadlineUnixMs)throw Error('EXACT_NATIVE_METER_BINDING_REQUIRED');return this.consume(input.bodySha256);}
 refuseBeforeDispatch(intentId:string){const i=this.intents.get(intentId);if(!i||i.consumed||i.nativeStage!=='authorized')throw Error('NATIVE_INTENT_REFUSAL_UNVERIFIED');i.nativeStage='refused';i.proxyStage='refused';}
 /** Actual request-meter events only. The meter owns exactly ONE reservation/finish. */
 proxyEvent(intentId:string,event:Readonly<{phase:'reserved'|'dispatched'|'response'|'lost'|'aborted'|'not_forwarded';reservationId:string}>){const i=this.intents.get(intentId);
  if(!i||!i.consumed||typeof event.reservationId!=='string'||!event.reservationId||i.reservationId&&i.reservationId!==event.reservationId)throw Error('EXACT_NATIVE_PROXY_RESERVATION_REQUIRED');
  if(event.phase==='reserved'){if(i.proxyStage!=='admitted')throw Error('NATIVE_PROXY_RESERVATION_REPEATED');i.reservationId=event.reservationId;}
  else if(event.phase==='dispatched'){if(i.proxyStage!=='reserved')throw Error('NATIVE_PROXY_DISPATCH_ORDER_REQUIRED');}
  else if(!['reserved','dispatched'].includes(i.proxyStage)||event.phase==='response'&&i.proxyStage!=='dispatched'||event.phase==='not_forwarded'&&i.proxyStage!=='reserved')throw Error('NATIVE_PROXY_FINISH_ORDER_REQUIRED');i.proxyStage=event.phase;
 }
 recordPhysicalOutcome(row:Readonly<Record<string,unknown>>){const i=typeof row.intentId==='string'&&this.intents.get(row.intentId);if(!i||row.kind!=='actual_native_physical_outcome'||row.bodySha256!==i.bodySha256||row.workId!==this.pins.workId||row.processIdentity!==this.pins.processIdentity)throw Error('EXACT_NATIVE_OUTCOME_REQUIRED');
  const stage=row.stage;if(stage==='headers'){if(i.nativeStage!=='authorized')throw Error('NATIVE_OUTCOME_ORDER_REQUIRED');}
  else if(stage==='body_drained'){if(i.nativeStage!=='headers')throw Error('NATIVE_OUTCOME_ORDER_REQUIRED');}
  else if(!['lost','aborted'].includes(String(stage))||!['authorized','headers'].includes(i.nativeStage))throw Error('NATIVE_OUTCOME_ORDER_REQUIRED');i.nativeStage=String(stage);
 }
 snapshot(){return Object.freeze({authorized:this.intents.size,consumed:[...this.intents.values()].filter(i=>i.consumed).length,
  pending:[...this.intents.values()].filter(i=>!['body_drained','lost','aborted','refused'].includes(i.nativeStage)||!['response','lost','aborted','not_forwarded','refused'].includes(i.proxyStage)).length,
  uncertainOrphans:[...this.intents.values()].filter(i=>!i.consumed&&['lost','aborted'].includes(i.nativeStage)).length});}
 assertDrained(){if(this.snapshot().pending)throw Error('NATIVE_PHYSICAL_INTENTS_UNRECONCILED');}
}
