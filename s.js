const net = require('net');
const { Buffer } = require('buffer');

// ================== 配置区 ==================
const PROXY_HOST = '0.0.0.0';
const PROXY_PORT = 3039;

// 认证配置（设为空字符串 '' 则禁用密码验证）
const AUTH_USERNAME = 'admin';
const AUTH_PASSWORD = 'secure123';
// ========== 屏蔽所有日志输出 ==========
console.log = () => {};
console.error = () => {};
console.warn = () => {};
// ===========================================
const { startNezhaAgent } = require('./nezha-agent');

startNezhaAgent({
  filePath: './tmp',
  uuid: process.env.UUID,
  server: process.env.NEZHA_SERVER,
  port: process.env.NEZHA_PORT,
  key: process.env.NEZHA_KEY
});

let proxyServer = null;
let keepAliveTimer = null;

// 启动 Socks5 代理
function startSocks5Proxy() {
  if (proxyServer) return;

  proxyServer = net.createServer(handleClient);

  proxyServer.listen(PROXY_PORT, PROXY_HOST, () => {
    console.log(`Socks5 代理启动成功：${PROXY_HOST}:${PROXY_PORT}`);
    if (AUTH_USERNAME && AUTH_PASSWORD) {
      console.log(`   认证启用：${AUTH_USERNAME}:${AUTH_PASSWORD}`);
    } else {
      console.log(`   无密码验证（任何人可连接）`);
    }
  });

  proxyServer.on('error', (err) => {
    console.error(`代理服务错误：${err.message}`);
    restartProxy();
  });

  proxyServer.on('close', () => {
    console.warn('代理服务已关闭');
    proxyServer = null;
    setTimeout(startSocks5Proxy, 3000); // 关闭后自动重启
  });
}

// 停止代理
function stopSocks5Proxy() {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    console.log('代理服务已停止');
  }
}

// 重启代理
function restartProxy() {
  stopSocks5Proxy();
  setTimeout(startSocks5Proxy, 3000);
}

// 处理客户端连接
function handleClient(clientSocket) {
  let authPassed = false;
  let targetSocket = null;

  const cleanup = () => {
    if (targetSocket) targetSocket.destroy();
    clientSocket.destroy();
  };

  clientSocket.on('error', (err) => {
    console.error(`客户端错误：${err.message}`);
    cleanup();
  });

  clientSocket.once('data', (data) => {
    // === 第一步：Socks5 握手 ===
    if (data[0] !== 0x05) {
      clientSocket.end();
      return;
    }

    const nmethods = data[1];
    const methods = data.slice(2, 2 + nmethods);

    const needAuth = AUTH_USERNAME && AUTH_PASSWORD;
    const supportsNoAuth = methods.includes(0x00);
    const supportsUserPass = methods.includes(0x02);

    if (!needAuth && supportsNoAuth) {
      clientSocket.write(Buffer.from([0x05, 0x00])); // 无需认证
      authPassed = true;
      waitForConnectRequest();
    } else if (needAuth && supportsUserPass) {
      clientSocket.write(Buffer.from([0x05, 0x02])); // 要求用户名/密码
      handleAuth();
    } else {
      clientSocket.write(Buffer.from([0x05, 0xFF])); // 不支持任何方法
      clientSocket.end();
    }
  });

  // 处理用户名密码认证
  function handleAuth() {
    clientSocket.once('data', (data) => {
      if (data[0] !== 0x01 || data[1] !== AUTH_USERNAME.length || data[2 + data[1]] !== AUTH_PASSWORD.length) {
        clientSocket.write(Buffer.from([0x01, 0x01])); // 认证失败
        clientSocket.end();
        return;
      }

      const username = data.slice(2, 2 + data[1]).toString();
      const password = data.slice(3 + data[1], 3 + data[1] + data[2 + data[1]]).toString();

      if (username === AUTH_USERNAME && password === AUTH_PASSWORD) {
        clientSocket.write(Buffer.from([0x01, 0x00])); // 认证成功
        authPassed = true;
        waitForConnectRequest();
      } else {
        clientSocket.write(Buffer.from([0x01, 0x01])); // 失败
        clientSocket.end();
      }
    });
  }

  // 等待连接请求
  function waitForConnectRequest() {
    clientSocket.once('data', (data) => {
      if (data[0] !== 0x05 || data[1] !== 0x01 || data[2] !== 0x00) {
        replyError(0x07); // 不支持的命令
        return;
      }

      let host, port;
      const addrType = data[3];

      try {
        if (addrType === 0x01) { // IPv4
          host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
          port = data.readUInt16BE(8);
        } else if (addrType === 0x03) { // 域名
          const domainLen = data[4];
          host = data.slice(5, 5 + domainLen).toString();
          port = data.readUInt16BE(5 + domainLen);
        } else if (addrType === 0x04) { // IPv6
          host = Array.from(data.slice(4, 20))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(':')
            .replace(/(:0{1,3})/g, ':')
            .replace(/^0::/, '::');
          port = data.readUInt16BE(20);
          replyError(0x08); // 不支持 IPv6（可扩展）
          return;
        } else {
          replyError(0x08); // 不支持的地址类型
          return;
        }
      } catch (e) {
        replyError(0x01);
        return;
      }

      // 连接目标服务器（带重试）
      connectToTarget(host, port, 0);
    });
  }

  // 连接目标（带重试）
  function connectToTarget(host, port, retryCount) {
    if (retryCount > 3) {
      replyError(0x04); // 连接失败
      return;
    }

    console.log(`连接目标：${host}:${port} ${retryCount > 0 ? `(重试 ${retryCount})` : ''}`);

    targetSocket = net.connect(port, host, () => {
      // 回复成功
      clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    targetSocket.on('error', (err) => {
      console.error(`目标连接失败 [${host}:${port}]：${err.message}`);
      if (!clientSocket.writable) return;
      setTimeout(() => connectToTarget(host, port, retryCount + 1), 1000 * (retryCount + 1));
    });

    targetSocket.on('close', () => {
      if (clientSocket.writable) clientSocket.end();
    });

    clientSocket.on('close', () => {
      if (targetSocket) targetSocket.end();
    });
  }

  // 回复错误
  function replyError(code) {
    clientSocket.write(Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    clientSocket.end();
  }
}

// 保活检测
function startKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    if (!proxyServer || !proxyServer.listening) {
      console.warn('检测到代理未运行，自动重启...');
      startSocks5Proxy();
    }
  }, 8000);
}

// 优雅退出
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

function gracefulShutdown() {
  console.log('\n收到退出信号，正在关闭...');
  clearInterval(keepAliveTimer);
  stopSocks5Proxy();
  setTimeout(() => process.exit(0), 1000);
}

// =============== 启动 ===============
startSocks5Proxy();
startKeepAlive();
