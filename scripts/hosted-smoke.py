#!/usr/bin/env python3
"""Check a disposable hosted container offline; all credentials are synthetic fixtures."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='infomaniak-ai:hosted-dev')
parser.add_argument('--disposable-dns', action='store_true')
args = parser.parse_args()
name = 'ik-hosted-check-' + uuid.uuid4().hex[:12]

def run(command, stage, script=None):
    result = subprocess.run(command, input=script, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(stage + ' failed: ' + result.stderr[-700:])
    return result.stdout.strip()

with tempfile.TemporaryDirectory(prefix='ik-hosted-container-') as directory:
    root = Path(directory)
    root.chmod(0o700)
    (root / 'state').mkdir(mode=0o700)
    (root / 'hosted-key').write_text(secrets.token_urlsafe(32) + '\n')
    (root / 'hosted-key').chmod(0o600)
    command = ['docker', 'run', '--detach', '--name', name, '--network', 'none', '--read-only',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
               '--user', str(os.getuid()) + ':' + str(os.getgid()),
               '--env', 'INFOMANIAK_HOSTED_BIND_HOST=0.0.0.0',
               '--env', 'INFOMANIAK_HOSTED_ORIGIN=https://hosted.example',
               '--env', 'INFOMANIAK_HOSTED_KEY_FILE=/run/secrets/hosted-key',
               '--env', 'INFOMANIAK_HOSTED_STATE_DIR=/var/lib/hosted',
               '--mount', 'type=bind,src=' + str(root / 'hosted-key') + ',dst=/run/secrets/hosted-key,readonly',
               '--mount', 'type=bind,src=' + str(root / 'state') + ',dst=/var/lib/hosted',
               '--tmpfs', '/tmp:size=32m,mode=1777', args.image, 'node', 'dist/server.js', '--hosted']
    # The write canary exercises the production default with no write setting.
    # The discovery-only canary explicitly opts out.
    if not args.disposable_dns:
        command[command.index('--tmpfs'):command.index('--tmpfs')] = ['--env', 'INFOMANIAK_HOSTED_DISPOSABLE_DNS_WRITES=false']
    try:
        run(command, 'Hosted start')
        for attempt in range(20):
            ready = subprocess.run(['docker', 'exec', name, 'node', 'dist/healthcheck.js'], capture_output=True, timeout=10)
            if ready.returncode == 0:
                break
            time.sleep(.25)
        else:
            raise RuntimeError('Hosted healthcheck failed')
        script = """
import {request} from 'node:http';
import {HostedStore,readHostedKey,fingerprint} from './dist/hosted-store.js';
import {randomUUID} from 'node:crypto';
const access='fixture-hosted-container-connection-credential';
const store=new HostedStore('/var/lib/hosted',readHostedKey('/run/secrets/hosted-key'));
const grant=randomUUID(),now=Date.now();
store.put('grant',grant,{activated:true,client:'fixture-client',owner:'fixture-owner',account:10,token:'fixture-no-network-provider-token',created:now,expires:now+600000},now+600000);
store.put('access',fingerprint(access),{client:'fixture-client',grant,expires:Math.floor((now+600000)/1000)},now+600000);
store.close();
const call=(path,data,token)=>new Promise((resolve,reject)=>{
  const req=request('http://127.0.0.1:8787'+path,{method:data?'POST':'GET',headers:{host:'hosted.example',...(data?{'content-type':'application/json',accept:'application/json, text/event-stream'}:{}),...(token?{authorization:'Bearer '+token}:{})}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);if(data)req.write(JSON.stringify(data));req.end();
});
const metadata=await call('/.well-known/oauth-protected-resource/mcp');
if(metadata.status!==200||JSON.parse(metadata.text).resource!=='https://hosted.example/mcp')throw new Error('Wrong resource metadata');
const denied=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'});
if(denied.status!==401||!denied.headers['www-authenticate'].includes('resource_metadata'))throw new Error('Anonymous MCP accepted');
const tools=await call('/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'},access);
if(tools.status!==200||JSON.parse(tools.text).result.tools.length!==6)throw new Error('Wrong hosted tools');
const status=await call('/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'infomaniak_status',arguments:{}}},access);
const result=JSON.parse(status.text).result.structuredContent;
if(result.writes_enabled!==false||result.hosted!==true||result.account_id!==10)throw new Error('Wrong hosted account boundary');
const writes=await call('/mcp',{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'infomaniak_execute',arguments:{approved:true}}},access);
if(!JSON.parse(writes.text).result.isError)throw new Error('Hosted write accepted');
console.log(JSON.stringify({passed:true,tools:6,writes:false,hosted:true,account_bound:true,anonymous_refused:true,network:'none'}));
"""
        if args.disposable_dns:
            script = script.replace("owner:'fixture-owner',account:10,", "owner:'fixture-owner',account:10,scopes:['infomaniak:read','infomaniak:write:disposable-dns'],writeZone:'example.test',")
            script = script.replace('tools.length!==6', 'tools.length!==10').replace('writes_enabled!==false', 'writes_enabled!==true').replace('tools:6,writes:false', 'tools:10,writes:true')
        result = run(['docker', 'exec', '-i', name, 'node', '--input-type=module'], 'Hosted MCP', script)
        security = json.loads(run(['docker', 'inspect', '--format', '{{json .HostConfig}}', name], 'Isolation check'))
        if not security['ReadonlyRootfs'] or security['NetworkMode'] != 'none' or 'ALL' not in security['CapDrop']:
            raise RuntimeError('Unexpected container isolation')
        run(['docker', 'kill', '--signal', 'KILL', name], 'Crash fixture')
        if args.disposable_dns:
            # An uncleanly stopped writer's encrypted lease must expire before recovery.
            time.sleep(31)
        run(['docker', 'start', name], 'Restart fixture')
        time.sleep(.5)
        run(['docker', 'exec', name, 'node', 'dist/healthcheck.js'], 'Restart health')
        replay = "import {request} from 'node:http';const access='fixture-hosted-container-connection-credential';\n" + script[script.index('const call='):]
        run(['docker', 'exec', '-i', name, 'node', '--input-type=module'], 'Persisted MCP credential after crash', replay)
        print(json.dumps({**json.loads(result), 'credential_survived_crash': True, 'read_only_root': True, 'crash_restart': True, 'native_platform_signin': False}))
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=30)
