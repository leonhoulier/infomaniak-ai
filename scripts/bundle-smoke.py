#!/usr/bin/env python3
"""Install the built bundle in a clean Node container, using fake discovery credentials."""
import argparse
import json
from pathlib import Path
import subprocess

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--bundle",default="artifacts/infomaniak-ai-0.2.0.tgz")
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
bundle=(root/args.bundle).resolve()
if not bundle.is_file():raise SystemExit("Build the local bundle first")
image=next(line.split()[1] for line in (root/"Dockerfile").read_text().splitlines() if line.startswith("FROM "))
script="""
import {spawnSync} from 'node:child_process';
const install=spawnSync('npm',['install','--prefix','/tmp/clean','--cache','/tmp/npm-cache','--ignore-scripts','--omit=dev','--no-audit','--no-fund','/bundle.tgz'],{encoding:'utf8'});
if(install.status!==0)throw new Error('Clean bundle dependency installation failed: '+install.stderr.slice(-300));
const binary='/tmp/clean/node_modules/infomaniak-ai/dist/server.js';
const env={...process.env,INFOMANIAK_API_TOKEN:'fixture-package-discovery-token-only'};
const preview=spawnSync('/tmp/clean/node_modules/.bin/infomaniak-ai',['setup','--client','codex','--dry-run'],{env,encoding:'utf8'});
if(preview.status!==0||!preview.stderr.includes('INFOMANIAK_API_TOKEN_FILE')||preview.stderr.includes(env.INFOMANIAK_API_TOKEN))throw new Error('Installed setup preview failed');
const doctor=spawnSync('/tmp/clean/node_modules/.bin/infomaniak-ai',['--doctor'],{env,encoding:'utf8'});
if(doctor.status!==0)throw new Error('Installed entrypoint failed: '+(doctor.error?.code??doctor.stderr.slice(-300)));
if(JSON.parse(doctor.stdout).mode!=='discovery-only')throw new Error('Unexpected installed mode');
const {Client}=await import('/tmp/clean/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {StdioClientTransport}=await import('/tmp/clean/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const client=new Client({name:'public-bundle-check',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[binary],env,stderr:'pipe'});
transport.stderr?.on('data',()=>{});
await client.connect(transport);
const tools=await client.listTools();
const status=await client.callTool({name:'infomaniak_status',arguments:{}});
if(tools.tools.length!==6||status.structuredContent.writes_enabled!==false||status.structuredContent.catalogue.operations!==1514)throw new Error('Installed bundle has unexpected capabilities');
await client.close();
const init=spawnSync('/tmp/clean/node_modules/.bin/infomaniak-ai-admin',['init','--directory','/tmp/private-policy','--account','10'],{env,encoding:'utf8'});
if(init.status!==0)throw new Error('Installed administrator entrypoint failed');
const scoped=new Client({name:'scoped-bundle-check',version:'1'});
const scopedTransport=new StdioClientTransport({command:process.execPath,args:[binary,'--config','/tmp/private-policy/access.local.json'],env,stderr:'pipe'});
scopedTransport.stderr?.on('data',()=>{});
await scoped.connect(scopedTransport);
const scopedTools=await scoped.listTools();
const scopedStatus=await scoped.callTool({name:'infomaniak_status',arguments:{}});
if(scopedTools.tools.length!==10||scopedStatus.structuredContent.writes_enabled!==false)throw new Error('Installed scoped runtime has unexpected capabilities');
await scoped.close();
console.log(JSON.stringify({passed:true,clean_install:true,node:process.version,tools:tools.tools.length,scoped_tools:scopedTools.tools.length,cli_entrypoints:true,setup_preview:true,catalogue:1514,writes:false}));
"""
# This test installs executables under /tmp; Docker otherwise mounts it noexec.
# The production runtime keeps its normal non-executable scratch mount.
command=["docker","run","--rm","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges:true",
 "--user","node","--tmpfs","/tmp:size=192m,mode=1777,exec","--mount","type=bind,src="+str(bundle)+",dst=/bundle.tgz,readonly",
 image,"node","--input-type=module","-e",script]
result=subprocess.run(command,capture_output=True,text=True,timeout=180)
if result.returncode:raise SystemExit("Clean bundle check failed: "+result.stderr[-1200:])
print(json.dumps(json.loads(result.stdout.strip())))
