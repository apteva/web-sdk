import {test,expect} from 'bun:test';
import {AptevaClient} from '../src';

test('remote discovery never redirects reads, writes or SSE away from the authenticated gateway',async()=>{
 const requests:{url:URL;method:string;authorization:string|null}[]=[];
 const client=new AptevaClient({baseURL:'https://gateway.example',apiKey:'test-key',fetch:(async(input,init)=>{
  const url=new URL(String(input));requests.push({url,method:init?.method||'GET',authorization:new Headers(init?.headers).get('Authorization')});
  if(url.pathname.endsWith('/deployment/endpoints'))return Response.json({install_id:42,deployment_generation:7,proxy_base:'https://gateway.example/api/apps/example/_install/42',browser_api_base:'https://remote.example/browser',endpoints:{media:'https://media.example'}});
  if(url.pathname.endsWith('/events'))return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"changed":true}\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}});
  return Response.json({ok:true});
 }) as typeof fetch});
 const endpoints=await client.apps.endpoints(42);expect(endpoints.endpoints?.media).toBe('https://media.example');
 const app=client.app('example',{installId:42,projectId:'project-a'});
 await app.get('/items');await app.post('/create',{value:1});
 let received=false;const stream=app.subscribe('/events',()=>{received=true;});
 try{for(let i=0;i<30&&!received;i++)await Bun.sleep(5);expect(received).toBe(true);}finally{stream.close();}
 expect(requests).toHaveLength(4);
 for(const r of requests){expect(r.url.origin).toBe('https://gateway.example');expect(r.authorization).toBe('Bearer test-key');}
 for(const r of requests.slice(1)){expect(r.url.searchParams.get('install_id')).toBe('42');expect(r.url.searchParams.get('project_id')).toBe('project-a');}
});
test('endpoint discovery rejects missing or invalid installation identities',()=>{
 const client=new AptevaClient({baseURL:'https://gateway.example'});
 for(const id of [0,-1,NaN,1.5,Infinity])expect(()=>client.apps.endpoints(id)).toThrow();
});
