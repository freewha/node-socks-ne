const net = require('net');
const { Buffer } = require('buffer');
const { startNezhaAgent } = require('./nezha-agent');

// ================== 配置区 ==================
const PROXY_HOST = '0.0.0.0';
const PROXY_PORT = 3039;

const AUTH_USERNAME = 'admin';
const AUTH_PASSWORD = 'secure123';
// ===========================================

// 启动哪吒探针
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
    console.log(`[启动] Socks5 代理监听 ${PROXY_HOST}:${PROXY_PORT}`);
    if (AUTH_USERNAME && AUTH_PASSWORD) {
      console.log(`[认证] 启用用户名密码认证：${AUTH_USERNAME}`);
    } else {
      console.log(`[认证] 未启用认证，允许匿名连接`);
    }
  });

  proxyServer.on('error', (err) => {
    console.log(`[错误] 代理服务异常：${err.message}`);
    restartProxy();
  });

  proxyServer.on('close', () => {
    proxyServer = null;
    setTimeout(startSocks5Proxy, 3000);
  });
}

// 停止代理
function stopSocks5Proxy() {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    console.log('[停止] 代理服务已停止');
  }
}

// 重启代理
function restartProxy() {
  stopSocks5Proxy();
  setTimeout(startSocks5Proxy, 3000);
}

// 处理客户端连接
function handleClient(clientSocket) {
  let targetSocket = null;

  const cleanup = () => {
    if (targetSocket) targetSocket.destroy();
    clientSocket.destroy();
  };

  clientSocket.on('error', cleanup);

  clientSocket.once('data', (data) => {
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
      clientSocket.write(Buffer.from([0x05, 0x00]));
      waitForConnectRequest();
    } else if (needAuth && supportsUserPass) {
      clientSocket.write(Buffer.from([0x05, 0x02]));
      handleAuth();
    } else {
      clientSocket.write(Buffer.from([0x05, 0xFF]));
      clientSocket.end();
    }
  });

  function handleAuth() {
    clientSocket.once('data', (data) => {
      if (data[0] !== 0x01 || data[1] !== AUTH_USERNAME.length || data[2 + data[1]] !== AUTH_PASSWORD.length) {
        clientSocket.write(Buffer.from([0x01, 0x01]));
        clientSocket.end();
        return;
      }

      const username = data.slice(2, 2 + data[1]).toString();
      const password = data.slice(3 + data[1], 3 + data[1] + data[2 + data[1]]).toString();

      if (username === AUTH_USERNAME && password === AUTH_PASSWORD) {
        clientSocket.write(Buffer.from([0x01, 0x00]));
        waitForConnectRequest();
      } else {
        clientSocket.write(Buffer.from([0x01, 0x01]));
        clientSocket.end();
      }
    });
  }

  function waitForConnectRequest() {
    clientSocket.once('data', (data) => {
      if (data[0] !== 0x05 || data[1] !== 0x01 || data[2] !== 0x00) {
        replyError(0x07);
        return;
      }

      let host, port;
      const addrType = data[3];

      try {
        if (addrType === 0x01) {
          host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
          port = data.readUInt16BE(8);
        } else if (addrType === 0x03) {
          const domainLen = data[4];
          host = data.slice(5, 5 + domainLen).toString();
          port = data.readUInt16BE(5 + domainLen);
        } else if (addrType === 0x04) {
          port = data.readUInt16BE(20);
          replyError(0x08);
          return;
        } else {
          replyError(0x08);
          return;
        }
      } catch {
        replyError(0x01);
        return;
      }

      connectToTarget(host, port, 0);
    });
  }

  function connectToTarget(host, port, retryCount) {
    if (retryCount > 3) {
      replyError(0x04);
      return;
    }

    console.log(`[连接] ${host}:${port} ${retryCount > 0 ? `(重试 ${retryCount})` : ''}`);

    targetSocket = net.connect(port, host, () => {
      clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    targetSocket.on('error', () => {
      console.log(`[失败] 无法连接 ${host}:${port}`);
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
      console.log('[保活] 检测到代理未运行，尝试重启...');
      startSocks5Proxy();
    }
  }, 8000);
}

// 优雅退出
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

function gracefulShutdown() {
  console.log('[退出] 收到退出信号，正在关闭...');
  clearInterval(keepAliveTimer);
  stopSocks5Proxy();
  setTimeout(() => process.exit(0), 1000);
}

// =============== 启动 ===============
startSocks5Proxy();
startKeepAlive();
