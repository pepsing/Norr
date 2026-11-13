if (window === window.top && location.origin === 'https://h5.app.polestar-auto.com'
    && location.pathname === '/account-components/auth-slider/index.html') {
  let submitting = false;
  const errors = new Set([
    '验证窗口连接未就绪，请重新加载后重试。',
    '无法确认验证页面', '验证页面来源无效', '验证状态不可用', '此验证窗口已失效',
    '验证结果过大', '验证结果格式无效', '验证回调地址无效', '验证回调缺少结果',
    '验证结果无效，请重新完成滑块验证',
  ]);
  const submit = async payload => {
    if (submitting) return;
    submitting = true;
    const status = document.getElementById('norr-verification-status');
    try {
      if (status) status.textContent = payload === null ? '正在取消验证…' : '验证已完成，正在返回 Norr…';
      if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') {
        throw new Error('验证窗口连接未就绪，请重新加载后重试。');
      }
      await window.__TAURI_INTERNALS__.invoke('submit_verification', { payload });
    } catch (error) {
      submitting = false;
      const message = typeof error === 'string' ? error : error?.message;
      let explanation = '验证结果未能提交，请重新加载后重试。';
      if (errors.has(message)) explanation = message;
      if (typeof message === 'string' && message.includes('not allowed')) {
        explanation = '验证提交被应用权限拦截，请更新 Norr 后重试。';
      }
      if (status) status.textContent = explanation;
    }
  };
  const receive = message => {
    if (typeof message === 'string') return submit(message);
    if (message && typeof message === 'object'
        && ['sessionId', 'sig', 'token'].every(key => typeof message[key] === 'string')) {
      return submit(JSON.stringify(message));
    }
  };
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin) receive(event.data);
  });
  window.chromium = { postMessage: receive };
  const handlers = { chinaVerification: { postMessage: receive }, dispatch: { postMessage: receive } };
  window.webkit = { messageHandlers: handlers };
  document.addEventListener('DOMContentLoaded', () => {
    const controls = document.createElement('div');
    controls.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:16px 20px;background:#f7f7f5;color:#20221f;font:14px system-ui;z-index:2147483647;';
    const status = document.createElement('p');
    status.id = 'norr-verification-status';
    status.textContent = '完成验证后会向所填手机号发送短信。';
    controls.appendChild(status);
    for (const [label, action] of [['重新加载', () => location.reload()], ['取消', () => submit(null)]]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.style.cssText = 'padding:8px 16px;margin-right:12px;font:inherit;cursor:pointer;';
      button.addEventListener('click', action);
      controls.appendChild(button);
    }
    document.body.appendChild(controls);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') submit(null); });
}
