const { exec } = require('child_process');
const { promisify } = require('util');
const { existsSync, writeFileSync, chmodSync, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const execAsync = promisify(exec);

// 判断系统架构
function getArch() {
  const arch = os.arch();
  return ['arm', 'arm64', 'aarch64'].includes(arch) ? 'arm' : 'amd';
}

// 生成随机文件名
function generateName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// 下载文件并授权
async function download(url, dest) {
  const writer = require('fs').createWriteStream(dest);
  const response = await axios({ method: 'get', url, responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      chmodSync(dest, 0o755);
      resolve(dest);
    });
    writer.on('error', reject);
  });
}

// 启动哪吒探针（支持参数注入）
async function startNezhaAgent({
  filePath = './tmp',
  uuid = '9afd1229-b893-40c1-84dd-51e7ce204913',
  server = '',
  port = '',
  key = ''
} = {}) {
  if (!server || !key) return;

  if (!existsSync(filePath)) mkdirSync(filePath, { recursive: true });

  const arch = getArch();
  const baseUrl = arch === 'arm' ? 'https://arm64.ssss.nyc.mn' : 'https://amd64.ssss.nyc.mn';
  const phpName = generateName();
  const npmName = generateName();
  const phpPath = path.join(filePath, phpName);
  const npmPath = path.join(filePath, npmName);

  if (!port) {
    // 哪吒 v1 模式
    const url = `${baseUrl}/v1`;
    await download(url, phpPath);

    const portNum = server.includes(':') ? server.split(':').pop() : '';
    const tls = ['443', '8443', '2096', '2087', '2083', '2053'].includes(portNum) ? 'true' : 'false';

    const configYaml = `
client_secret: ${key}
server: ${server}
uuid: ${uuid}
tls: ${tls}
report_delay: 4
skip_connection_count: true
skip_procs_count: true
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
debug: false
temperature: false
gpu: false
use_gitee_to_upgrade: false
use_ipv6_country_code: false
insecure_tls: true
`;

    const configPath = path.join(filePath, 'config.yaml');
    writeFileSync(configPath, configYaml);

    await execAsync(`nohup ${phpPath} -c "${configPath}" >/dev/null 2>&1 &`);
  } else {
    // 哪吒 v0 模式
    const url = `${baseUrl}/agent`;
    await download(url, npmPath);

    const tlsFlag = ['443', '8443', '2096', '2087', '2083', '2053'].includes(port) ? '--tls' : '';
    const cmd = `nohup ${npmPath} -s ${server}:${port} -p ${key} ${tlsFlag} --disable-auto-update --report-delay 4 --skip-conn --skip-procs >/dev/null 2>&1 &`;
    await execAsync(cmd);
  }
}

// 导出模块
module.exports = { startNezhaAgent };

// 如果直接运行此文件，则使用环境变量启动
if (require.main === module) {
  startNezhaAgent({
    filePath: process.env.FILE_PATH,
    uuid: process.env.UUID,
    server: process.env.NEZHA_SERVER,
    port: process.env.NEZHA_PORT,
    key: process.env.NEZHA_KEY
  });
}
