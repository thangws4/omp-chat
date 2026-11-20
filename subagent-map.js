// The Subagents tab: one per chat, filling the editor area. It draws the run as a tree (the lead, the subagents it
// spawned, theirs under them) and shows one agent's conversation live, with a box to steer it. The chat owns the data
// (ChatProvider.mapState / transcriptData / subagentControl); this file only moves it between the chat and the tab.
const vscode = require('vscode');
const crypto = require('crypto');

const FOLLOW_MS = 700; // an open conversation refetches at most this often while its agent works

class SubagentMap {
  constructor(chat) {
    this.chat = chat;
    this.selected = null;
    this.focus = null;
    this.timer = null;
    const media = vscode.Uri.joinPath(chat.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('ompChat.map', `${chat.t('Subagents')} · ${chat.title}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => {
      clearTimeout(this.timer);
      if (this.chat.map === this) this.chat.map = null;
    });
  }

  open(focusId) {
    if (focusId) this.focus = focusId;
    this.panel.reveal();
    this.update();
  }

  post(m) { this.panel.webview.postMessage(m); }

  update() { this.post({ type: 'state', ...this.chat.mapState(), focus: this.focus }); }

  // The agent moved: refresh its conversation if it is the one open (trailing, so the last state always shows).
  agentActivity(id) {
    if (id !== this.selected || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.sendTranscript(id); }, FOLLOW_MS);
  }

  async sendTranscript(id) {
    try {
      this.post({ type: 'transcript', ...await this.chat.transcriptData(id) });
    } catch (e) {
      this.post({ type: 'error', id, text: `Could not read ${id}'s conversation: ${e.message}` });
    }
  }

  async onMessage(m) {
    switch (m?.type) {
      case 'ready': return this.update();
      case 'select':
        this.selected = m.id || null;
        this.focus = null;
        if (this.selected) await this.sendTranscript(this.selected);
        return;
      case 'steer': case 'stop':
        return this.chat.subagentControl(m.type, m.id, m.text, (text) => this.post({ type: 'error', id: m.id, text }));
    }
  }

  dispose() { this.panel.dispose(); }

  html(webview) {
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.chat.context.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('vendor/codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('map.css')}">
</head><body>
<div id="app"><div id="top"></div><div id="tree"></div><div id="grip" hidden></div><div id="pane" hidden></div></div>
<script nonce="${nonce}" type="application/json" id="l10n">${JSON.stringify(this.chat.dictionary ?? null).replace(/</g, '\\u003c')}</script>
<script nonce="${nonce}" src="${uri('l10n.js')}"></script>
<script nonce="${nonce}" src="${uri('vendor/markdown-it.min.js')}"></script>
<script nonce="${nonce}" src="${uri('map.js')}"></script>
</body></html>`;
  }
}

module.exports = { SubagentMap };
