import {EventEmitter} from 'node:events';
import {createSecureContext} from 'node:tls';
import {prepareWsdlRequest,createWsdlEvidenceClient} from '../src/index.mjs';
export const plan=(model='55',operation='protocol')=>prepareWsdlRequest({model,operation,requestId:'synthetic-only'});
export function wsdl(p=plan()){
 return Buffer.from(`<?xml version="1.0" encoding="utf-8"?><wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="http://synthetic.invalid/service" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" targetNamespace="http://synthetic.invalid/service"><wsdl:message name="request"/><wsdl:message name="response"/><wsdl:portType name="portType"><wsdl:operation name="query"><wsdl:input message="tns:request"/><wsdl:output message="tns:response"/></wsdl:operation></wsdl:portType>${['soap','soap12'].map(s=>`<wsdl:binding name="${s}" type="tns:portType"><${s}:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/><wsdl:operation name="query"><${s}:operation soapAction="http://synthetic.invalid/service/query"/><wsdl:input><${s}:body use="literal"/></wsdl:input><wsdl:output><${s}:body use="literal"/></wsdl:output></wsdl:operation></wsdl:binding>`).join('')}<wsdl:service name="Service">${['soap','soap12'].map(s=>`<wsdl:port name="${s}" binding="tns:${s}"><${s}:address location="${p.endpoint}"/></wsdl:port>`).join('')}</wsdl:service></wsdl:definitions>`);
}
export function fixture(config={}){
 const p=config.plan??plan(),bytes=config.bytes??wsdl(p),state={calls:0,writes:0,closedRequest:0,closedSocket:0,closedResponse:0,sessionCalls:0};
 state.requestImpl=(options,callback)=>{
  state.calls++;state.options=options;state.callback=callback;if(config.throwDriver)throw new Error('SECRET_DRIVER_ERROR');
  const req=new EventEmitter(),socket=new EventEmitter(),res=new EventEmitter();Object.assign(state,{req,socket,res});
  req.destroy=()=>state.closedRequest++;socket.destroy=()=>state.closedSocket++;res.destroy=()=>state.closedResponse++;
  socket.encrypted=config.encrypted??true;socket.authorized=config.authorized??true;socket.getProtocol=()=>config.protocol??'TLSv1.3';
  res.statusCode=config.status??200;res.complete=config.complete??true;res.headers={'content-type':'text/xml; charset=utf-8','content-length':String(bytes.length),...config.headers};for(const k of Object.keys(res.headers))if(res.headers[k]===undefined)delete res.headers[k];res.rawHeaders=config.rawHeaders??Object.entries(res.headers).flat();
  req.end=(...args)=>{state.writes++;state.args=args;if(config.throwWrite)throw new Error('SECRET_WRITE');if(config.noResponse)return;queueMicrotask(()=>{callback(res);if(state.closedResponse)return;if(config.closeOnly){res.emit('close');return;}if(config.stallBody)return;res.emit('data',bytes);res.emit('end');});};
  queueMicrotask(()=>{req.emit('socket',socket);if(config.connectionFail)req.emit('error',new Error('SECRET_SOCKET'));else if(!config.noHandshake)socket.emit('secureConnect');});return req;
 };
 state.port=config.port??(async(context,action,options)=>{state.sessionCalls++;state.context=context;state.sessionOptions=options;await action(createSecureContext({minVersion:'TLSv1.2'}));});
 state.client=createWsdlEvidenceClient({requestImpl:state.requestImpl,withAuthorizedTlsSession:state.port});state.plan=p;return state;
}
