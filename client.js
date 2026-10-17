// Harness browser plugin ABI; shared React is supplied by the desktop loader.
window.__ModuleLoader__.load({
  id: 'dsh-jev-mode',
  factory(require) {
    const React = require('react');
    const { Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const REF = 'TYPESAFE_API_KEY';
    const NS = 'settings.jev';
    const zh = {
      title: 'JEV 决策模型', tag: '插件', description: '为 JEV 模式配置你自己的 TypeSafe 密钥。DeepSeek 主模型继续使用原有配置。',
      provider: '提供商', protocol: '决策接口', key: 'API 密钥', empty: '粘贴你自己的 TypeSafe API 密钥',
      replacement: '已配置；输入新密钥可更换', loading: '正在读取配置状态…', configured: '密钥已配置', missing: '尚未配置密钥',
      sourceFile: '来源：Harness 凭据存储', sourceEnv: '来源：启动环境（只读）', sourceDotenv: '来源：环境配置文件', sourceOther: '来源：宿主凭据服务',
      save: '保存密钥', replace: '更换密钥', remove: '移除已保存密钥', confirm: '确认移除', cancel: '取消', refresh: '刷新状态',
      saving: '正在保存…', removing: '正在移除…', invalid: '请只粘贴密钥本身，不要包含空格、引号或变量名。',
      saved: '已保存。后续 JEV 请求将使用当前凭据；此处仅确认保存成功。',
      removed: '已移除已保存密钥。', fallback: '已移除已保存密钥；宿主仍从环境配置文件读取凭据。',
      readonly: '此密钥由启动环境提供，无法在应用内更换或移除。请先移除启动环境中的同名变量，再重启应用。',
      unavailable: '无法读取凭据状态，请检查宿主凭据服务后刷新。', failedSave: '保存失败，请检查宿主凭据服务后重试。',
      failedRemove: '移除失败，请检查宿主凭据服务后重试。',
      note: '密钥由 Harness 凭据服务保存，不进入模型对话。此页面不验证 API 连通性。',
      noKey: '未配置时，明确读取照常；语义判断回退，危险操作保留宿主审批。',
      confirmText: '移除会影响使用同一 TypeSafe 凭据的功能。继续移除？',
      edit: '编辑', close: '关闭',
    };
    const en = {
      title: 'JEV decision model', tag: 'Plugin', description: 'Configure your own TypeSafe key for JEV mode. DeepSeek keeps its existing model configuration.',
      provider: 'Provider', protocol: 'Decision endpoint', key: 'API key', empty: 'Paste your own TypeSafe API key',
      replacement: 'Configured; enter a new key to replace it', loading: 'Loading credential status…', configured: 'Key configured', missing: 'No key configured',
      sourceFile: 'Source: Harness credential store', sourceEnv: 'Source: launch environment (read-only)', sourceDotenv: 'Source: environment file', sourceOther: 'Source: host credential service',
      save: 'Save key', replace: 'Replace key', remove: 'Remove stored key', confirm: 'Confirm removal', cancel: 'Cancel', refresh: 'Refresh status',
      saving: 'Saving…', removing: 'Removing…', invalid: 'Paste only the key, without spaces, quotes or a variable name.',
      saved: 'Saved. Subsequent JEV requests use the current credential; this confirms storage only.',
      removed: 'Stored key removed.', fallback: 'Stored key removed; the host still resolves a credential from an environment file.',
      readonly: 'The launch environment supplies this key. Remove that environment variable and restart the app before changing it here.',
      unavailable: 'Unable to read credential status. Check the host credential service and refresh.', failedSave: 'Unable to save. Check the host credential service and retry.',
      failedRemove: 'Unable to remove. Check the host credential service and retry.',
      note: 'Harness stores the credential; it is never added to model conversations. This page does not test API connectivity.',
      noKey: 'Without a key, explicit reads still work; semantic decisions fall back and dangerous operations retain host approval.',
      confirmText: 'Removing this credential affects features sharing the same TypeSafe key. Continue?',
      edit: 'Edit', close: 'Close',
    };

    // Status is projected explicitly even if a future server returns extra data.
    // Exceptions and remote errors are never shown verbatim: they may echo input.
    function createOperations(remote) {
      return {
        async describe() {
          try {
            const response = await remote.describe([REF]);
            const info = response.ok && response.value?.[REF];
            if (!info || typeof info.configured !== 'boolean' || typeof info.writable !== 'boolean') return { ok: false };
            return { ok: true, info: { configured: info.configured, writable: info.writable, source: typeof info.source === 'string' ? info.source : undefined } };
          } catch { return { ok: false }; }
        },
        async save(value) {
          try { return { ok: (await remote.set(REF, value)).ok === true }; }
          catch { return { ok: false }; }
        },
        async remove() {
          try { return { ok: (await remote.unset(REF)).ok === true }; }
          catch { return { ok: false }; }
        },
      };
    }
    function validKey(value) {
      return typeof value === 'string' && value.length > 0 && value.length <= 8192
        && /^[\x21-\x7e]+$/.test(value) && !/["'=]/.test(value);
    }
    function JevSettingsCard({ operations, t, subscribe }) {
      const [opened, setOpened] = React.useState(false);
      const [info, setInfo] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const [error, setError] = React.useState(false);
      const [confirm, setConfirm] = React.useState(false);
      const alive = React.useRef(true);
      const generation = React.useRef(0);
      const inFlight = React.useRef(false);
      const id = React.useId();
      const load = React.useCallback(async () => {
        const current = ++generation.current;
        const result = await operations.describe();
        if (!alive.current || current !== generation.current) return null;
        setInfo(result.ok ? result.info : null);
        if (!result.ok) { setMessage('unavailable'); setError(true); }
        else setMessage(previous => previous === 'unavailable' ? '' : previous);
        return result.ok ? result.info : null;
      }, [operations]);
      React.useEffect(() => {
        alive.current = true;
        void load();
        const dispose = subscribe(() => { void load(); });
        return () => { alive.current = false; ++generation.current; dispose(); };
      }, [load, subscribe]);
      function announce(key, failed = false) { if (alive.current) { setMessage(key); setError(failed); } }
      function close() {
        if (inFlight.current) return;
        setOpened(false); setDraft(''); setConfirm(false); setMessage(''); setError(false);
      }
      async function save(event) {
        event.preventDefault();
        if (inFlight.current || !info?.writable) return;
        const value = draft.trim();
        setDraft('');
        setConfirm(false);
        if (!validKey(value)) { announce('invalid', true); return; }
        inFlight.current = true; setBusy(true); setMessage('');
        try {
          const result = await operations.save(value);
          if (!result.ok) { announce('failedSave', true); return; }
          const next = await load();
          if (next) announce('saved');
        } finally { inFlight.current = false; if (alive.current) setBusy(false); }
      }
      async function remove() {
        if (inFlight.current || !info?.writable) return;
        inFlight.current = true; setBusy(true); setDraft(''); setMessage('');
        try {
          const result = await operations.remove();
          if (!result.ok) { announce('failedRemove', true); return; }
          const next = await load();
          if (next) announce(next.configured ? 'fallback' : 'removed');
        } finally { inFlight.current = false; if (alive.current) { setBusy(false); setConfirm(false); } }
      }
      const locked = !info?.writable || busy;
      const source = info?.source === 'file' ? 'sourceFile' : info?.source === 'env' ? 'sourceEnv'
        : ['project-env', 'user-env'].includes(info?.source) ? 'sourceDotenv' : 'sourceOther';
      const button = (text, props = {}) => h('button', { type: 'button', className: 'jev-key-button', disabled: busy, ...props }, t(text));
      const summary = info ? t(info.configured ? 'configured' : 'missing') : t(message === 'unavailable' ? 'unavailable' : 'loading');
      return h(React.Fragment, null,
        h('section', { className: 'jev-key-card', 'aria-labelledby': id + '-title' },
          h('div', { className: 'jev-key-heading' }, h('h3', { id: id + '-title' }, t('title')),
            h('span', { className: 'jev-key-dot' + (info?.configured ? ' jev-key-ready' : ''), role: 'status', 'aria-label': summary, title: summary })),
          button('edit', { 'aria-haspopup': 'dialog', 'aria-expanded': opened, onClick: () => { setDraft(''); setMessage(''); setError(false); setConfirm(false); setOpened(true); void load(); } })),
        h(Modal, { open: opened, onClose: close, title: t('title'), closeLabel: t('close'), description: t('description'), className: 'jev-key-modal', contentClassName: 'jev-key-modal-content',
          footer: button('close', { onClick: close }) },
        h('div', { className: 'jev-key-editor' },
        h('div', { className: 'jev-key-details' }, h('span', null, t('provider') + ': TypeSafe · JEV'), h('span', null, t('protocol') + ': SystemOne')),
        message !== 'unavailable' && h('div', { className: 'jev-key-status', role: 'status' }, info ? t(info.configured ? 'configured' : 'missing') : t('loading'),
          info?.configured && h('span', { className: 'jev-key-source' }, t(source))),
        h('form', { onSubmit: save, autoComplete: 'off' },
          h('label', { htmlFor: id + '-key' }, t('key')),
          h('input', { id: id + '-key', type: 'password', value: draft, disabled: locked, maxLength: 8192,
            'data-modal-autofocus': true, autoComplete: 'new-password', spellCheck: false, autoCapitalize: 'none', autoCorrect: 'off',
            placeholder: t(info?.configured ? 'replacement' : 'empty'), onChange: e => setDraft(e.target.value) }),
          h('div', { className: 'jev-key-actions' }, button(busy && !confirm ? 'saving' : info?.configured ? 'replace' : 'save', { type: 'submit', className: 'jev-key-button jev-key-primary', disabled: locked || !draft.trim() }),
            info?.configured && button('remove', { disabled: locked || confirm, onClick: () => { setDraft(''); setConfirm(true); } }),
            button('refresh', { onClick: () => { setMessage(''); setError(false); void load(); } }))),
        confirm && h('div', { className: 'jev-key-confirm' }, h('p', null, t('confirmText')), h('div', { className: 'jev-key-actions' },
          button(busy ? 'removing' : 'confirm', { disabled: locked, onClick: remove }), button('cancel', { onClick: () => setConfirm(false) }))),
        info && !info.writable && h('p', null, t('readonly')),
        message && message !== 'unavailable' && h('p', { role: error ? 'alert' : 'status', className: error ? 'jev-key-error' : 'jev-key-result' }, t(message)),
        message === 'unavailable' && h('p', { role: 'alert', className: 'jev-key-error' }, t('unavailable')),
        h('p', { className: 'jev-key-note' }, t('note')), !info?.configured && h('p', { className: 'jev-key-note' }, t('noKey')))));
    }
    const css = `
      /* Match the host ModelsSection rowCard/rowActions metrics, without relying on its private CSS-module class names. */
      .jev-key-card{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;max-width:720px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke,#e0e0e0);border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#262626);font:inherit}
      .jev-key-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary,#999)}.jev-key-ready{background:var(--dsw-alias-state-success-primary,#0bbd6b)}.jev-key-modal{width:min(640px,100%);max-height:100%}.jev-key-modal-content{min-height:0;overflow-y:auto}
      .jev-key-heading{display:flex;align-items:center;gap:6px;min-width:0}.jev-key-heading h3{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:22px}.jev-key-tag{font-size:12px;border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:20px;padding:2px 8px;color:var(--dsw-alias-label-secondary,#70757d)}
      .jev-key-editor p{margin:12px 0;line-height:1.6;font-size:14px;color:var(--dsw-alias-label-secondary,#70757d)}.jev-key-details{display:flex;flex-wrap:wrap;gap:8px 24px;font-size:13px;color:var(--dsw-alias-label-secondary,#70757d)}
      .jev-key-status{margin:16px 0;font-size:14px}.jev-key-source{display:block;margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#70757d)}.jev-key-editor label{display:block;font-size:14px;margin-bottom:8px}
      .jev-key-editor input{box-sizing:border-box;width:100%;height:40px;border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:var(--dsw-radius-md,8px);padding:0 12px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:14px;outline:none}.jev-key-editor input:focus-visible,.jev-key-button:focus-visible{outline:2px solid var(--dsw-alias-focus-ring-color,#4166ff);outline-offset:2px}
      .jev-key-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.jev-key-button{min-height:34px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:13px;cursor:pointer}.jev-key-button:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,#eee)}.jev-key-primary{background:var(--dsw-alias-button-primary-fill,#4166ff);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}.jev-key-primary:hover:enabled{filter:brightness(.94);background:var(--dsw-alias-button-primary-fill,#4166ff)}.jev-key-button:disabled,.jev-key-editor input:disabled{opacity:.5;cursor:default}
      .jev-key-card>.jev-key-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;min-height:0;height:28px;padding:0 10px;border-width:.5px;border-radius:var(--dsw-radius-sm,8px);background:transparent;font-size:12px;line-height:18px}
      .jev-key-confirm{border-top:1px solid var(--dsw-alias-border-l3,#ddd);margin-top:16px;padding-top:4px}.jev-key-editor .jev-key-note{font-size:12px;margin-bottom:0}.jev-key-editor .jev-key-error{color:var(--dsw-alias-state-error-primary,#c63b36)}.jev-key-editor .jev-key-result{color:var(--dsw-alias-state-success-primary,#22835c)}
    `;
    const inject = ['slots', 'locale', 'remote', 'remote.credentials'];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'JEV settings: translations');
      ctx.effect(() => {
        const style = document.createElement('style'); style.textContent = css; document.head.append(style);
        return () => style.remove();
      }, 'JEV settings: styles');
      const operations = createOperations(ctx.remote.credentials);
      const subscribe = listener => {
        const dispose = [ctx.remote.$on('credentials/reference-updated', listener), ctx.on('connection/reset', listener)];
        return () => { for (const stop of dispose) stop(); };
      };
      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
        name: 'settings.models.footer', id: 'jev-credentials', order: 100,
        inject: () => ({ operations, t: ctx.locale.bind(NS), subscribe }),
      }, JevSettingsCard));
    }
    return { apply, inject, createOperations, validKey, JevSettingsCard };
  },
});
