import { hana } from './sdk.js';
import { initializeWorkflow } from './workflow-ui.js';

const startup = document.getElementById('startup');
hana.ready();
async function load() {
  const values = new URLSearchParams(window.location.search).getAll('workflowId');
  if (values.length !== 1 || !/^wf_[A-Za-z0-9_-]+$/.test(values[0])) {
    throw new Error('这张卡片没有绑定有效工作流。请在会话中生成画布；不会自动显示其他卡片或最新记录。');
  }
  const workflowId = values[0];
  const response = await hana.api.fetch('workflow/' + encodeURIComponent(workflowId));
  if (!response.ok) throw new Error('工作流读取失败（' + response.status + '），请检查应用授权和记录状态。');
  const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
  const dataNode = parsed.getElementById('workflow-data');
  if (!dataNode) throw new Error('工作流响应缺少实例数据。');
  const data = JSON.parse(dataNode.textContent);
  if (data.workflowId !== workflowId || !Array.isArray(data.edges)) throw new Error('工作流标识不匹配，已停止呈现。');
  // Response HTML supplies markup and styles only; never execute backend-provided code.
  for (const node of parsed.querySelectorAll('script,iframe,object,embed,link,base')) node.remove();
  for (const node of parsed.querySelectorAll('*')) {
    for (const attr of Array.from(node.attributes)) {
      if (/^on/i.test(attr.name) || attr.name === 'srcdoc') node.removeAttribute(attr.name);
    }
  }
  for (const style of parsed.head.querySelectorAll('style')) document.head.append(document.importNode(style, true));
  document.body.replaceChildren(...Array.from(parsed.body.childNodes, n => document.importNode(n, true)));
  document.title = parsed.title;
  initializeWorkflow(data, hana);
}
load().catch(error => {
  const node = startup.isConnected ? startup : document.createElement('main');
  node.id = 'startup'; node.dataset.error = 'true'; node.setAttribute('role','alert');
  node.textContent = error?.message || '画布加载失败。';
  if (!node.isConnected) document.body.replaceChildren(node);
  hana.ui.resize({height:160});
});
