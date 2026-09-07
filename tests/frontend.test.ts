import { test, expect } from "bun:test";
import { AptevaClient } from "../src/client";
const sha=(value:string)=>new Bun.CryptoHasher("sha256").update(value).digest("hex");
const clientSource='export function createClient({app},options){return {name:app.name,scope:app.projectId,options};}';
const base={schema:"apteva-app-frontend/v1",app:"example",version:"1.2.3",client:{path:"/ui/client.mjs",sha256:sha(clientSource)}};
function fixture(spec:unknown=base,source=clientSource){const calls:{url:string;init?:RequestInit}[]=[];const client=new AptevaClient({baseURL:"https://platform.test",accessToken:"visitor-token",fetch:(async(input:any,init?:RequestInit)=>{calls.push({url:String(input),init});return String(input).includes("frontend.json")?Response.json(spec):new Response(source,{headers:{"Content-Type":"text/javascript"}});}) as typeof fetch});return {client,calls};}
const scope={projectId:"project",installId:7};
test("headless app loading uses scoped bearer fetches and creates a fresh client",async()=>{
 const {client,calls}=fixture();const one=await client.apps.load<any>("example",{...scope,clientOptions:{identity:"alice"}});const two=await client.apps.load<any>("example",{...scope,clientOptions:{identity:"bob"}});
 expect(one.client).toEqual({name:"example",scope:"project",options:{identity:"alice"}});expect(two.client.options.identity).toBe("bob");expect(one.client).not.toBe(two.client);expect(one.components).toEqual({});
 for(const call of calls){const u=new URL(call.url);expect(u.searchParams.get("project_id")).toBe("project");expect(u.searchParams.get("install_id")).toBe("7");expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer visitor-token");expect(call.init?.credentials).toBe("omit");expect(call.init?.redirect).toBe("error");expect(call.url).not.toContain("visitor-token");if(!u.pathname.endsWith("frontend.json")){expect(call.init?.cache).toBe("force-cache");expect(u.searchParams.get("sha256")).toBe(base.client.sha256);}}
 one.dispose();two.dispose();
});
test("rejects wrong app, schema, version, scope and escaping asset paths before module execution",async()=>{
 for(const spec of [{...base,app:"other"},{...base,schema:"unknown"},...['https://evil.test/a.mjs','/ui/../a.mjs','/ui/%2e%2e/a.mjs','//evil.test/a.mjs','/ui/a.mjs?token=x','/ui//a.mjs'].map(path=>({...base,client:{...base.client,path}}))]){
  const {client,calls}=fixture(spec);await expect(client.apps.load("example",scope)).rejects.toThrow();expect(calls.length).toBe(1);
 }
 await expect(fixture().client.apps.load("example",{...scope,expectedVersion:"2.0.0"})).rejects.toThrow("version");
 await expect(fixture().client.apps.load("example",{projectId:"project"})).rejects.toThrow("installId");
});
test("rejects tampered code even if a verified module is cached",async()=>{
 await fixture().client.apps.load("example",scope);
 await expect(fixture(base,clientSource+'\n// changed').client.apps.load("example",scope)).rejects.toThrow("integrity mismatch");
});
test("rejects incompatible React and missing client exports",async()=>{
 const spec={...base,ui:{path:"/ui/ui.mjs",sha256:sha(''),reactMajor:19,components:["chat"]}};
 await expect(fixture(spec).client.apps.load("example",{...scope,react:{version:"18.0.0",createElement(){}}})).rejects.toThrow("React 19");
 const source='export const wrong = true;';await expect(fixture({...base,client:{...base.client,sha256:sha(source)}},source).client.apps.load("example",scope)).rejects.toThrow("createClient");
});
test("already-aborted loads do not execute a client factory",async()=>{
 const controller=new AbortController();controller.abort();await expect(fixture().client.apps.load("example",{...scope,signal:controller.signal})).rejects.toThrow();
});

function uiFixture(){
 const uiSource='export function createFrontend({react}){return {components:{chat:()=>react.version}};}';
 const css='.example { color: red; }';
 const spec={...base,ui:{path:"/ui/ui.mjs",sha256:sha(uiSource),reactMajor:19,components:["chat"]},styles:{path:"/ui/style.css",sha256:sha(css)}};
 let denied=false,corrupt=false;
 const client=new AptevaClient({baseURL:"https://platform.test",accessToken:"token",fetch:(async(input:any)=>{if(denied)return new Response("denied",{status:403});const path=new URL(String(input)).pathname;return path.endsWith("frontend.json")?Response.json(spec):new Response(path.endsWith("ui.mjs")?uiSource:path.endsWith(".css")?(corrupt?"bad":css):clientSource);}) as typeof fetch});
 const elements:any[]=[];const doc={head:{appendChild(element:any){elements.push(element)}},createElement(){const el={dataset:{},textContent:"",remove(){const i=elements.indexOf(el);if(i>=0)elements.splice(i,1)}};return el}} as unknown as Document;
 return {client,doc,elements,deny:()=>{denied=true},corrupt:()=>{corrupt=true}};
}
test("UI factories share host React but isolate exports; styles are reference counted",async()=>{
 const f=uiFixture(),react={version:"19.2.8",createElement(){}};
 const a=await f.client.apps.load<any,()=>string>("example",{...scope,react,document:f.doc});
 const b=await f.client.apps.load<any,()=>string>("example",{...scope,react,document:f.doc});
 expect(a.components.chat()).toBe("19.2.8");expect(a.components.chat).not.toBe(b.components.chat);expect(f.elements.length).toBe(1);
 a.dispose();a.dispose();expect(f.elements.length).toBe(1);b.dispose();expect(f.elements.length).toBe(0);
});
test("a failed asset load installs no styles and a later authorized load can recover",async()=>{
 const f=uiFixture();f.corrupt();await expect(f.client.apps.load("example",{...scope,react:{version:"19.2.8",createElement(){}},document:f.doc})).rejects.toThrow("integrity mismatch");expect(f.elements.length).toBe(0);
 const good=uiFixture();const loaded=await good.client.apps.load("example",{...scope,react:{version:"19.2.8",createElement(){}},document:good.doc});expect(good.elements.length).toBe(1);loaded.dispose();
});
test("cached code never bypasses a subsequent authorization denial",async()=>{
 const f=uiFixture();await f.client.apps.load("example",scope);f.deny();await expect(f.client.apps.load("example",scope)).rejects.toThrow("denied");
});
test("manifest changes select the new code instead of a stale cached module",async()=>{
 const previous=await fixture().client.apps.load<any>("example",scope);
 const nextSource='export function createClient(){return {updated:true}}';
 const next=await fixture({...base,version:"2.0.0",client:{path:"/ui/client-new.mjs",sha256:sha(nextSource)}},nextSource).client.apps.load<any>("example",scope);
 expect(previous.version).toBe("1.2.3");expect(next.version).toBe("2.0.0");expect(next.client.updated).toBe(true);
});

test("client, UI and stylesheet downloads start together after the manifest",async()=>{
 const ui='export function createFrontend(){return {components:{chat(){}}}}',css='.chat{}';
 const spec={...base,ui:{path:"/ui/ui.mjs",sha256:sha(ui),reactMajor:19,components:["chat"]},styles:{path:"/ui/style.css",sha256:sha(css)}};
 const release:Array<()=>void>=[];
 const client=new AptevaClient({baseURL:"https://platform.test",fetch:(async(input:any)=>{const path=new URL(String(input)).pathname;if(path.endsWith("frontend.json"))return Response.json(spec);await new Promise<void>(resolve=>release.push(resolve));return new Response(path.endsWith("client.mjs")?clientSource:path.endsWith("ui.mjs")?ui:css);}) as typeof fetch});
 const document=uiFixture().doc;
 const pending=client.apps.load("example",{...scope,react:{version:"19.2.8",createElement(){}},document});
 await new Promise(resolve=>setTimeout(resolve,5));
 try{expect(release.length).toBe(3);}finally{for(const resolve of release)resolve();}
 const loaded=await pending;loaded.dispose();
});
