import test from'node:test';import assert from'node:assert/strict';
import{productRoute,productMethods,productOperation,productResponse}from'../src/product-registry.mjs';

// Leva H, lane produtos (410): /v1/cadastros/products/:id/variacoes. Synthetic data only.
const P='10000000-0000-4000-8000-000000000410',C='20000000-0000-4000-8000-000000000410',CMD='30000000-0000-4000-8000-000000000410';
const req=(method,body)=>new Request(`https://api.synthetic.test/v1/cadastros/products/${P}/variacoes`,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
const readBody=async request=>request.json();
test('410 variations routes: strict body, the pai of the path and a checked answer',async()=>{
 const route=productRoute(`/v1/cadastros/products/${P}/variacoes`);assert.deepEqual(productMethods(route),['GET','POST']);
 const op=await productOperation(req('POST',{command_id:CMD,attributes:{' Cor ':'Azul '},code:'CAM-AZ',price:'55.0000'}),route,new URLSearchParams(),{body:readBody});
 assert.deepEqual([op.rpc,op.args],['erp_catalog_product_variation_add',{p_command_id:CMD,p_parent:P,p_data:{attributes:{Cor:'Azul'},code:'CAM-AZ',price:'55.0000'}}]);
 for(const bad of[{command_id:CMD,attributes:{},code:'X'},{command_id:CMD,attributes:{Cor:'A',cor:'B'},code:'X'},{command_id:CMD,attributes:{Cor:'A'},code:''},{command_id:CMD,attributes:{Cor:'A'},code:'X',gtin:'12'},{command_id:CMD,attributes:{Cor:'A'},code:'X',extra:1}])
  await assert.rejects(()=>productOperation(req('POST',bad),route,new URLSearchParams(),{body:readBody}),e=>e.status===400,JSON.stringify(bad));
 const view={data_mode:'erp_native',parent:{id:P,name:'Camiseta',code:'CAM',format:'V'},children:[{id:C,name:'Camiseta Azul',code:'CAM-AZ',active:true,gtin:null,price:'55.0000',attributes:{Cor:'Azul'}}]};
 assert.equal(productResponse({...view,scope:'product_variation_command',replayed:false,child_id:C},route,op).child_id,C);
 assert.throws(()=>productResponse({...view,scope:'product_variation_command',replayed:false,child_id:P},route,op),e=>e.status===502);
});
