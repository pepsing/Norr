const icon = (name, extra = '') => `<img class="icon ${extra}" src="assets/${name}.svg" width="24" height="24" alt="" aria-hidden="true">`;
const asset = 'assets/vehicle.webp';
const comfortTemperature = 22;
const action = (label, id, { staticView = false, primary = false, disabled = false, image = '' } = {}) => {
  const content = `${image ? icon(image) : ''}${label}`;
  const classes = `watch-action${primary ? ' primary' : ''}`;
  return staticView ? `<span class="${classes}">${content}</span>` : `<button class="${classes}" type="button" data-action="${id}"${disabled ? ' disabled' : ''}>${content}</button>`;
};
const titlebar = (title, back = false) => `${back ? `<button class="watch-back" type="button" data-action="home" aria-label="返回车辆概览">${icon('ChevronLeft')}</button>` : ''}<div class="watch-titlebar${back ? ' has-back' : ''}"><span class="brand">${title}</span><span>10:09</span></div>`;
const track = () => '<div class="energy-track"><i></i></div>';
const readings = () => '<div class="reading-row"><span class="battery-number">78<small>%</small></span><span class="range-number">356 <small>km</small></span></div>';

function homeView({ staticView = false, partial = false, active = state.active, locked = state.locked } = {}) {
  return `<div class="vehicle-heading"><span>Polestar 2</span><span class="inline-lock">${icon(partial ? 'CircleAlert' : locked ? 'LockKeyhole' : 'LockKeyholeOpen')}${partial ? '门锁未知' : locked ? '已锁车' : '已解锁'}</span></div>
    <img class="vehicle-photo" src="${asset}" width="1440" height="810" alt="Snow 白色 Polestar 2 Long range Dual motor 侧面" fetchpriority="high">
    ${readings()}${track()}<div class="meta-line">${partial ? '电量已更新 · 门锁读取失败' : '更新于 10:08'}</div>
    <div class="home-action home-controls">${action('门锁', 'locks', { staticView, primary: !partial && !locked, image: 'LockKeyhole' })}${action('空调', 'climate', { staticView, primary: active, image: 'Fan' })}</div>
    ${staticView ? '' : `${commandLink()}<div class="watch-nav-row">${action('充电状态', 'charging', { image: 'PlugZap' })}</div><div style="margin-top:7px">${action('刷新车辆', 'refresh', { image: 'RefreshCw' })}</div>`}`;
}

function climateView({ staticView = false, active = false, denied = false, busy = false } = {}) {
  if (active) return `<div class="climate-status active">${icon('Fan')}空调运行中</div><div class="climate-big">22<small>°C</small></div><p class="active-note">回读目标温度 · 车内 23 °C</p>${action('关闭空调', 'stop', { staticView, disabled: denied || busy })}<p class="center-note">车辆回读确认 · ${staticView ? '10:08' : state.climateTime}</p>`;
  return `<div class="climate-status">${icon('Fan')}空调已关闭</div><div class="climate-big comfort-value">${comfortTemperature}<small>°C</small></div><p class="comfort-note">默认舒适温度</p>${action('开启空调', 'start', { staticView, primary: true, disabled: denied || busy })}<p class="center-note">${denied ? '当前账号没有空调控制权限' : busy ? '请先查看上一条操作结果' : '车内 23 °C · 更新于 10:08'}</p>`;
}

function lockReason() {
  return {
    partial: '门锁读取失败，请先刷新状态',
    'lock-denied': '当前账号没有门锁控制权限',
    'lock-unsupported': '此车辆不支持远程门锁控制',
    'lock-unknown': '门锁控制能力尚未确认',
  }[state.scenario] || '';
}
function lockView({ staticView = false, locked = true, busy = false } = {}) {
  const unknown = !staticView && state.scenario === 'partial';
  const reason = staticView ? '' : lockReason();
  return `<div class="lock-vehicle">Polestar 2</div><div class="lock-status">${icon(unknown ? 'CircleAlert' : locked ? 'LockKeyhole' : 'LockKeyholeOpen')}<h3>${unknown ? '门锁状态未知' : locked ? '车辆已锁定' : '车辆已解锁'}</h3></div><p class="lock-time">${unknown ? '门锁读取失败' : `车辆更新 · ${staticView ? '10:08' : state.lockTime}`}</p>${action(unknown ? '门锁状态未知' : locked ? '解锁车辆' : '锁定车辆', locked ? 'ask-unlock' : 'ask-lock', { staticView, primary: !reason && !busy, disabled: !!reason || busy })}<p class="center-note">${reason || (busy ? '请先查看上一条操作结果' : '下一步确认，不立即发送')}</p>${!staticView && reason ? `<div class="lock-refresh">${action('刷新门锁状态', 'refresh-lock', { image: 'RefreshCw' })}</div>` : ''}`;
}
function confirmLockView(intent, staticView = false) {
  const unlock = intent === 'unlock';
  return `<div class="lock-confirm"><h3>${unlock ? '确认解锁？' : '确认锁车？'}</h3><p>${unlock ? '解锁 Polestar 2，<br>车门可从车外打开。' : '锁定 Polestar 2 的车门。'}</p>${action(unlock ? '确认解锁' : '确认锁车', 'confirm-lock', { staticView, primary: true })}${action('取消', 'cancel-lock', { staticView })}</div>`;
}
function commandDetails(intent = state.intent) {
  return {
    start: { label: `开启空调 · 默认 ${comfortTemperature} °C`, result: '空调已开启', icon: 'Fan' },
    stop: { label: '关闭空调', result: '空调已关闭', icon: 'Fan' },
    lock: { label: '锁定 Polestar 2', result: '车辆已锁定', icon: 'LockKeyhole' },
    unlock: { label: '解锁 Polestar 2', result: '车辆已解锁', icon: 'LockKeyholeOpen' },
  }[intent];
}
function commandLink() {
  return state.operation ? `<div class="command-link">${action(state.operation === 'confirmed' ? '查看操作结果' : '查看待完成操作', 'continue-command')}</div>` : '';
}
function observedState() {
  return state.commandPage === 'locks' ? `${state.locked ? '仍为已锁定' : '仍为已解锁'} · ${state.lockTime}` : `${state.active ? '仍在运行' : '仍为已关闭'} · ${state.climateTime}`;
}

function chargingView(staticView = false) {
  return `<div class="charging-title">${icon('PlugZap')}正在充电</div><div class="charge-number">78<small>%</small></div>${track()}<div class="metric-pair"><span>充电功率</span><strong>7.2 kW</strong></div><div class="metric-pair"><span>目标电量</span><strong>90%</strong></div><p class="charge-remaining">约 1 小时 18 分<span>车辆预计 · 更新于 10:08</span></p>${staticView ? '' : `<div style="margin-top:12px">${action('刷新充电状态', 'refresh-charge', { image: 'RefreshCw' })}</div>`}`;
}

function stateView(kind, staticView = false) {
  const details = commandDetails();
  if (kind === 'accepted') return `${icon('Check', 'state-icon')}<h3 class="state-title">服务已接收</h3><p class="state-copy">${details.label}<br>正在核对车辆状态</p><div class="state-progress">${icon('RefreshCw')}等待车辆回读</div><p class="center-note">尚未确认车辆完成操作</p>`;
  if (kind === 'pending') return `${icon('CircleAlert', 'state-icon')}<h3 class="state-title">结果待核对</h3><p class="state-copy">${details.label}<br>${state.evidence === 'mismatch' ? `最新观测：${observedState()}` : state.evidence === 'stale' ? '仅有指令前的旧读数' : '已发出，暂未收到车辆确认。'}</p>${action('核对车辆状态', 'verify', { staticView })}<p class="center-note">只读取状态，不重复发送</p>`;
  if (kind === 'offline') return `<div class="climate-status">${icon('WifiOff')}暂时无法联网</div><div class="offline-readings">${readings()}</div><p class="offline-time">上次更新 · 09:42</p>${action('重新读取', 'refresh-offline', { staticView })}<p class="center-note">显示缓存，暂不可控制车辆</p>`;
  if (kind === 'expired') return `${icon('Smartphone', 'state-icon')}<h3 class="state-title">登录已失效</h3><p class="state-copy">请在 iPhone 打开 Norr，<br>恢复登录后同步到手表。</p>${action('检查登录状态', 'check-session', { staticView })}`;
  if (kind === 'unconfigured') return `${icon('Smartphone', 'state-icon')}<h3 class="state-title">在 iPhone 登录</h3><p class="state-copy">打开手机 Norr 并登录，<br>再选择同步到 Apple Watch。</p>${action('检查同步', 'sync', { staticView })}`;
  if (kind === 'empty') return `${icon('CircleAlert', 'state-icon')}<h3 class="state-title">还没有车辆</h3><p class="state-copy">请在 iPhone 的 Norr 中<br>选择已关联的车辆。</p>${action('检查车辆', 'check-vehicles', { staticView })}`;
  if (kind === 'sending') return `${icon(details.icon, 'state-icon')}<h3 class="state-title">正在发送</h3><p class="state-copy">${details.label}<br>请稍候</p><div class="state-progress">指令已提交一次</div>`;
  if (kind === 'verifying') return `${icon('RefreshCw', 'state-icon')}<h3 class="state-title">正在核对</h3><p class="state-copy">${details.label}<br>读取最新状态，不重发指令。</p>`;
  if (kind === 'confirmed') return `${icon('Check', 'state-icon')}<h3 class="state-title">${details.result}</h3><p class="state-copy">${state.commandPage === 'locks' ? 'Polestar 2<br>' : state.active ? '回读目标温度 22 °C<br>' : ''}车辆回读一致 · 10:09</p>${action(state.commandPage === 'locks' ? '返回门锁' : '返回空调', 'command-result')}`;
  return `${icon('RefreshCw', 'state-icon')}<h3 class="state-title">正在读取车辆</h3><p class="state-copy">等待新的观测结果</p>`;
}

const state = { page: 'home', scenario: 'normal', active: false, locked: true, lockTime: '10:08', climateTime: '10:08', operation: '', commandPage: '', confirmIntent: '', evidence: '', intent: 'start', timers: [] };
const screenData = [
  { code: 'W01', title: '车辆概览', bar: 'Norr<b>.</b>', html: homeView({ staticView: true, locked: false, active: true }), caption: '示例为车辆已解锁、空调运行。对应入口显示橙色，由车辆回读驱动。' },
  { code: 'W02', title: '默认舒适温度', bar: '空调', html: climateView({ staticView: true }), caption: '沿用当前 Norr，以默认 22 °C 开启空调。温度只读，不提供加减。' },
  { code: 'W03', title: '空调运行', bar: '空调', html: climateView({ staticView: true, active: true }), caption: '运行状态使用暖橙。车辆回读确认后，提供关闭操作。' },
  { code: 'W04', title: '查看充电', bar: '充电', html: chargingView(true), caption: '保留电量、功率和目标。首版以读取为主，不编辑充电计划。' },
];
const lockData = [
  { code: 'W11', title: '门锁已锁定', bar: '门锁', html: lockView({ staticView: true }), caption: '显示门锁独立更新时间。点击解锁进入确认页，不直接发送。' },
  { code: 'W12', title: '确认解锁', bar: '门锁', html: confirmLockView('unlock', true), caption: '明确目标车型和解锁后果。确认发送一次，取消不发送。' },
  { code: 'W13', title: '门锁已解锁', bar: '门锁', html: lockView({ staticView: true, locked: false }), caption: '回读确认解锁后，概览同步锁态。可继续进入锁车确认。' },
  { code: 'W14', title: '确认锁车', bar: '门锁', html: confirmLockView('lock', true), caption: '锁车也保留确认步骤。回执后核对实际锁态和观测时间。' },
];
const stateData = [
  { code: 'W05', title: '回执不等于完成', bar: '空调', kind: 'accepted', caption: '服务已接收后继续回读。此时不使用“已开启”的成功文案。' },
  { code: 'W06', title: '结果不明', bar: '空调', kind: 'pending', caption: '只提供状态核对。网络超时不触发第二次车辆指令。' },
  { code: 'W07', title: '完全离线', bar: 'Norr<b>.</b>', kind: 'offline', caption: '保留原始更新时间。缓存不变成新读数，车控暂不可用。' },
  { code: 'W08', title: '恢复登录', bar: 'Norr<b>.</b>', kind: 'expired', caption: '清楚说明需要在手机完成的步骤，手表可以再次检查同步。' },
];
function card(item) {
  return `<figure class="screen-card"><div class="screen-stage"><div class="watch-shell"><div class="watch" role="img" aria-label="${item.code} ${item.title}，静态设计示例">${titlebar(item.bar)}<div class="watch-content">${item.html ?? stateView(item.kind, true)}</div></div></div></div><figcaption><div class="caption-heading"><span>${item.code}</span><h3>${item.title}</h3></div><p>${item.caption}</p></figcaption></figure>`;
}
document.getElementById('primary-screens').innerHTML = screenData.map(card).join('');
document.getElementById('lock-screens').innerHTML = lockData.map(card).join('');
document.getElementById('state-screens').innerHTML = stateData.map(card).join('');

const simulator = document.getElementById('simulator');
const scenarioInput = document.getElementById('scenario');
function later(fn, delay) { state.timers.push(setTimeout(fn, delay)); }
function clearTimers() { state.timers.forEach(clearTimeout); state.timers = []; }
function announce(text) {
  document.getElementById('announcement').textContent = text;
  const log = document.getElementById('event-log');
  const line = document.createElement('li');
  line.textContent = text;
  log.append(line);
  while (log.children.length > 5) log.firstElementChild.remove();
}
function render(focusAction = '') {
  let html;
  let title = 'Norr<b>.</b>';
  let back = false;
  if (['offline', 'expired', 'unconfigured', 'empty'].includes(state.scenario)) html = stateView(state.scenario);
  else if (state.page === 'loading') html = stateView('loading');
  else if (state.page === 'climate') {
    title = '空调'; back = true;
    html = state.operation && state.commandPage === 'climate' ? stateView(state.operation) : climateView({ active: state.active, denied: state.scenario === 'denied', busy: !!state.operation }) + commandLink();
  } else if (state.page === 'locks') {
    title = '门锁'; back = true;
    html = state.operation && state.commandPage === 'locks' ? stateView(state.operation) : state.confirmIntent ? confirmLockView(state.confirmIntent) : lockView({ locked: state.locked, busy: !!state.operation }) + commandLink();
  } else if (state.page === 'charging') { title = '充电'; back = true; html = chargingView(); }
  else html = homeView({ partial: state.scenario === 'partial' });
  simulator.innerHTML = `${titlebar(title, back)}<div class="watch-content" tabindex="0" aria-label="手表页面，可上下滚动">${html}</div>`;
  if (focusAction) simulator.querySelector(`[data-action="${focusAction}"]`)?.focus({ preventScroll: true });
}
function beginCommand(intent) {
  const door = intent === 'lock' || intent === 'unlock';
  if (state.operation || (door ? lockReason() : state.scenario === 'denied')) return;
  state.confirmIntent = '';
  state.commandPage = door ? 'locks' : 'climate';
  state.intent = intent;
  state.evidence = '';
  state.operation = 'sending';
  announce(`演示：${commandDetails().label}请求已发送一次`);
  render();
  later(() => {
    if (state.scenario === 'timeout') {
      state.operation = 'pending';
      announce('演示：请求超时，结果待核对；没有重发');
      render('verify');
      return;
    }
    state.operation = 'accepted';
    announce('演示：服务已接收，等待车辆回读');
    render();
    later(readBack, 1400);
  }, 1000);
}
function readBack() {
  if (state.scenario === 'mismatch' || state.scenario === 'stale') {
    state.evidence = state.scenario;
    if (state.scenario === 'mismatch') state[state.commandPage === 'locks' ? 'lockTime' : 'climateTime'] = '10:09';
    state.operation = 'pending';
    announce(state.evidence === 'mismatch' ? `演示：回读不一致，${observedState()}；保留待核对，没有重发` : '演示：只有指令前的旧读数，保留待核对，没有重发');
  } else {
    if (state.commandPage === 'locks') { state.locked = state.intent === 'lock'; state.lockTime = '10:09'; }
    else { state.active = state.intent === 'start'; state.climateTime = '10:09'; }
    state.operation = 'confirmed';
    announce(`演示：独立回读一致，${commandDetails().result}`);
  }
  render(state.page === state.commandPage ? state.operation === 'confirmed' ? 'command-result' : 'verify' : '');
}
function navigate(page) {
  state.confirmIntent = '';
  state.page = page;
  render(page === 'home' ? 'locks' : '');
}
simulator.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const id = button.dataset.action;
  if (id === 'home') navigate('home');
  if (id === 'climate') { navigate('climate'); announce('已进入空调，开启时使用默认舒适温度 22 °C'); }
  if (id === 'locks') { navigate('locks'); announce('已进入门锁，解锁和锁车都需要确认'); }
  if (id === 'charging') { navigate('charging'); announce('已进入充电状态'); }
  if (id === 'continue-command') navigate(state.commandPage);
  if (id === 'ask-lock' || id === 'ask-unlock') {
    if (state.operation || lockReason()) return;
    state.confirmIntent = id === 'ask-lock' ? 'lock' : 'unlock';
    render('cancel-lock'); announce(`待确认：${state.confirmIntent === 'lock' ? '锁定' : '解锁'} Polestar 2，尚未发送`);
  }
  if (id === 'cancel-lock') { state.confirmIntent = ''; render(state.locked ? 'ask-unlock' : 'ask-lock'); announce('已取消，未发送门锁指令'); }
  if (id === 'confirm-lock' && state.confirmIntent) beginCommand(state.confirmIntent);
  if (id === 'start' || id === 'stop') beginCommand(id);
  if (id === 'command-result') { state.operation = ''; state.commandPage = ''; render(); }
  if (id === 'verify') {
    state.operation = 'verifying'; render(); announce('正在只读核对，没有重新提交指令');
    later(readBack, 1100);
  }
  if (id === 'refresh' || id === 'refresh-charge' || id === 'refresh-lock') {
    const next = id === 'refresh-charge' ? 'charging' : id === 'refresh-lock' ? 'locks' : 'home';
    state.page = 'loading'; render(); announce('演示：正在读取车辆');
    later(() => { state.page = next; render(); announce(state.scenario === 'partial' ? '电量读取成功，门锁仍读取失败' : lockReason() ? `门锁状态已读取；${lockReason()}` : '演示快照已刷新，数值保持固定样例'); }, 900);
  }
  if (id === 'refresh-offline') announce('仍然离线，保留 09:42 的缓存；未提交车控');
  if (id === 'check-session') announce('尚未收到新登录态，请在 iPhone 恢复登录');
  if (id === 'check-vehicles') announce('尚未同步车辆，请在 iPhone 选择车辆');
  if (id === 'sync') {
    announce('演示：正在接收手机配置');
    later(() => { state.scenario = 'normal'; scenarioInput.value = 'normal'; state.page = 'home'; render(); announce('演示同步完成，已载入 Polestar 2'); }, 900);
  }
});
function reset() {
  clearTimers(); state.page = 'home'; state.active = scenarioInput.value === 'active'; state.locked = scenarioInput.value !== 'active'; state.lockTime = '10:08'; state.climateTime = '10:08'; state.operation = ''; state.intent = 'start'; state.commandPage = ''; state.confirmIntent = ''; state.evidence = '';
  state.scenario = scenarioInput.value;
  document.getElementById('event-log').innerHTML = '';
  render(); announce(`演示情境：${scenarioInput.selectedOptions[0].textContent}`);
}
scenarioInput.addEventListener('change', reset);
document.getElementById('size').addEventListener('change', (event) => {
  document.getElementById('simulator-shell').classList.toggle('compact', event.target.value === 'compact');
  announce(event.target.value === 'compact' ? '紧凑尺寸，内容可垂直滚动' : '标准尺寸');
});
document.getElementById('reset').addEventListener('click', () => { scenarioInput.value = 'normal'; reset(); });
simulator.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.confirmIntent) { state.confirmIntent = ''; render(state.locked ? 'ask-unlock' : 'ask-lock'); announce('已取消，未发送门锁指令'); }
  else if (event.key === 'Escape' && state.page !== 'home') navigate('home');
});
render();
