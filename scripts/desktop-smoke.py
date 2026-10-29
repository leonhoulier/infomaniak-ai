#!/usr/bin/env python3
"""Run the desktop bundle offline in a clean Node container with a fake token."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bundle', default=f'artifacts/infomaniak-ai-{version}.mcpb')
args = parser.parse_args()
image = next(line.split()[1] for line in (root / 'Dockerfile').read_text().splitlines() if line.startswith('FROM '))
script = """
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Client} from '/extension/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '/extension/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const manifest=JSON.parse(readFileSync('/extension/manifest.json','utf8'));
const config=manifest.server.mcp_config;
if(Object.keys(manifest.user_config).length!==1||!manifest.user_config.api_token.sensitive)throw new Error('Unexpected desktop credential settings');
const env={INFOMANIAK_API_TOKEN_FILE:'/must-not-read-inherited-token',INFOMANIAK_POLICY_FILE:'/must-not-load-inherited-policy',INFOMANIAK_MCP_SERVER_PATH:'/must-not-launch-inherited-backend',INFOMANIAK_MCP_SHA256:'a'.repeat(64),...Object.fromEntries(Object.entries(config.env).map(([key,value])=>[key,value.replaceAll('${user_config.api_token}','fixture-offline-desktop-only')]))};
const args=config.args.map(arg=>arg.replaceAll('${__dirname}','/extension'));
const doctor=spawnSync(process.execPath,[...args,'--doctor'],{env,encoding:'utf8'});
if(doctor.status!==0||JSON.parse(doctor.stdout).mode!=='discovery-only')throw new Error('Bundled entrypoint failed');
const client=new Client({name:'desktop-offline-check',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args,env,stderr:'pipe'});
transport.stderr?.on('data',()=>{});
try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  const status=(await client.callTool({name:'infomaniak_status',arguments:{}})).structuredContent;
  if(tools.length!==6||status.writes_enabled!==false||status.catalogue.operations!==1514)throw new Error('Unexpected desktop capabilities');
  if(!/never ask for tokens in chat/i.test(client.getInstructions()))throw new Error('Missing onboarding instructions');
  console.log(JSON.stringify({passed:true,node:process.version,bundled_dependencies:true,offline:true,tools:6,writes:false,native_ui_tested:false}));
} finally {await client.close();}
"""
with tempfile.TemporaryDirectory(prefix='infomaniak-desktop-check-') as directory:
    destination = Path(directory)
    with zipfile.ZipFile(root / args.bundle) as archive:
        for item in archive.infolist():
            path = Path(item.filename)
            if path.is_absolute() or '..' in path.parts:
                raise SystemExit('Unsafe archive member')
            if path.parts[0] not in {'manifest.json', 'package.json', 'package-lock.json', 'LICENSE', 'dist', 'data', 'node_modules'}:
                raise SystemExit('Unexpected archive member')
        archive.extractall(destination)
    command = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges:true', '--user', str(os.getuid()) + ':' + str(os.getgid()),
               '--mount', 'type=bind,src=' + str(destination) + ',dst=/extension,readonly',
               image, 'node', '--input-type=module', '-e', script]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise SystemExit('Desktop bundle check failed: ' + result.stderr[-1200:])
    print(json.dumps(json.loads(result.stdout.strip())))
