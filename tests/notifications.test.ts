import {describe,test,expect} from "bun:test";
import {AptevaClient} from "../src";
import {startStubServer,json} from "./stub-server";

describe("personal notification previews",()=>{
  test("preview changes do not replace delivery channel preferences",async()=>{
    const stub=startStubServer();try {
      stub.setRoute("GET","/api/notifications/previews",()=>json({mobile_preview:"hidden"}));
      stub.setRoute("PUT","/api/notifications/previews",()=>json({mobile_preview:"content"}));
      const client=new AptevaClient({baseURL:stub.url,apiKey:"preview-test"});
      expect((await client.notifications.previews()).mobile_preview).toBe("hidden");
      expect((await client.notifications.setPreviews({mobile_preview:"content"})).mobile_preview).toBe("content");
      expect(stub.last()?.headers.authorization).toBe("Bearer preview-test");
      expect(stub.all().every(x=>x.path==="/api/notifications/previews")).toBe(true);
    } finally {await stub.stop();}
  });
});
