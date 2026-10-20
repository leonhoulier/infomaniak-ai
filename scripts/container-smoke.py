#!/usr/bin/env python3
"""Validate one disposable container with fake credentials and networking disabled."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import uuid

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--image",default="infomaniak-ai:local-0.2.0")
args=parser.parse_args()
name="infomaniak-ai-smoke-"+uuid.uuid4().hex[:12]
def run(command,stage):
    result=subprocess.run(command,text=True,capture_output=True,timeout=60)
    if result.returncode:
        raise RuntimeError(stage+" failed: "+result.stderr[-500:])
    return result.stdout.strip()
def ready():
    for _ in range(15):
        result=subprocess.run(["docker","exec",name,"node","dist/healthcheck.js"],capture_output=True,timeout=10)
        if result.returncode==0:
            return
        time.sleep(.3)
    raise RuntimeError("Container healthcheck did not pass")

with tempfile.TemporaryDirectory(prefix="infomaniak-ai-container-") as directory:
    root=Path(directory);root.chmod(0o700)
    (root/"state").mkdir(mode=0o700)
    client,human,provider=(secrets.token_hex(32) for _ in range(3))
    digest=lambda value:hashlib.sha256(value.encode()).hexdigest()
    policy={"version":1,"state_directory":"/var/lib/infomaniak-ai","local_principal":"owner",
      "principals":[{"id":"owner","credential_env":"INFOMANIAK_API_TOKEN","access_token_sha256":digest(client),
       "approval_token_sha256":digest(human),"accounts":[10],"resources":{
        "zones":{"example.com":{"account_id":10,"disposable":True,"writable":False}},
        "dns_names":{"example.com:test":{"account_id":10,"disposable":True,"writable":False}}},
       "operations":["dns.records.list","dns.record.create"],"writes":"disabled"}],
      "remote":{"host":"0.0.0.0","port":8787,"public_origin":"http://127.0.0.1:8787"}}
    for filename,content in [("access.local.json",json.dumps(policy)),("provider-token",provider)]:
        (root/filename).write_text(content);(root/filename).chmod(0o600)
    command=["docker","run","--detach","--name",name,"--network","none","--read-only",
      "--cap-drop","ALL","--security-opt","no-new-privileges:true","--user",str(os.getuid())+":"+str(os.getgid()),
      "--env","INFOMANIAK_POLICY_FILE=/run/secrets/access.local.json","--env","INFOMANIAK_API_TOKEN_FILE=/run/secrets/provider-token",
      "--mount","type=bind,src="+str(root/"access.local.json")+",dst=/run/secrets/access.local.json,readonly",
      "--mount","type=bind,src="+str(root/"provider-token")+",dst=/run/secrets/provider-token,readonly",
      "--mount","type=bind,src="+str(root/"state")+",dst=/var/lib/infomaniak-ai",
      "--tmpfs","/tmp:size=32m,mode=1777",args.image]
    try:
        run(command,"Container start");ready()
        script="""
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client=new Client({name:'isolated-container-smoke',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp'),{requestInit:{headers:{authorization:'Bearer '+CLIENT_TOKEN}}}));
const tools=await client.listTools();
const status=await client.callTool({name:'infomaniak_status',arguments:{}});
if(tools.tools.length!==8||status.structuredContent.catalogue.operations!==1514||status.structuredContent.writes_enabled!==false)throw new Error('Unexpected runtime capabilities');
const denied=await client.callTool({name:'infomaniak_plan',arguments:{operation:'dns.record.create',arguments:{account_id:10,zone:'example.com',source:'test',type:'A',target:'192.0.2.1',ttl:300}}});
if(!denied.isError||JSON.parse(denied.content[0].text).code!=='writes_disabled')throw new Error('Write policy failed');
await client.close();
console.log(JSON.stringify({tools:tools.tools.length,catalogue:1514,write_rejection:true}));
""".replace("CLIENT_TOKEN",json.dumps(client))
        result=json.loads(run(["docker","exec",name,"node","--input-type=module","-e",script],"SDK protocol check"))
        run(["docker","kill","--signal","KILL",name],"Disposable process crash")
        run(["docker","start",name],"Restart");ready()
        isolation=json.loads(run(["docker","inspect","--format",'{"user":"{{.Config.User}}","read_only":{{.HostConfig.ReadonlyRootfs}},"network":"{{.HostConfig.NetworkMode}}"}',name],"Isolation inspection"))
        assert isolation["read_only"] is True and isolation["network"]=="none" and not isolation["user"].startswith("0:")
        print(json.dumps({"passed":True,"checks":result,"isolation":isolation,"crash_restart":True,"healthcheck_command":True}))
    finally:
        subprocess.run(["docker","rm","--force",name],capture_output=True,timeout=30)
