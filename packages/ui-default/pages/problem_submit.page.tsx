import $ from 'jquery';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { renderLanguageSelect } from 'vj/components/languageselect';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getAvailableLangs, i18n, request, tpl } from 'vj/utils';

const page = new NamedPage(['problem_submit', 'contest_detail_problem_submit', 'homework_detail_problem_submit'], async () => {
  const { config } = UiContext.pdoc;
  if (config.type === 'submit_answer') {
    $('[name="lang"]').val('_');
    return;
  }
  const availableLangs = getAvailableLangs(config.langs);
  const mainLangs = {};
  const preferences = [UserContext.codeLang || ''];
  for (const key in availableLangs) {
    const base = key.split('.')[0];
    if (config.langs && !config.langs.filter((i) => i === key || i === base || i.startsWith(`${base}.`)).length) continue;
    if (window.LANGS[key].pretest === preferences[0]) preferences.push(key);
    if (!key.includes('.')) mainLangs[key] = window.LANGS[key].display;
    else {
      const a = key.split('.')[0];
      mainLangs[a] = window.LANGS[a].display;
    }
  }
  for (const key in availableLangs) {
    const base = key.split('.')[0];
    if (config.langs && !config.langs.filter((i) => i === key || i === base || i.startsWith(`${base}.`)).length) continue;
    if (typeof window.LANGS[key]?.pretest === 'string' && window.LANGS[key].pretest.split('.')[0] === preferences[0].split('.')[0]) {
      preferences.push(key);
    }
  }

  renderLanguageSelect(
    document.getElementById('codelang-selector'),
    '[name="lang"]',
    availableLangs,
    mainLangs,
    preferences,
  );

  const form = document.querySelector('[data-ai-check-form]') as HTMLFormElement | null;
  const statusNode = document.querySelector('[data-ai-check-status]') as HTMLDivElement | null;
  if (form && UiContext.aiCheckUrl) {
    const buildFallbackPayload = (message: string) => ({
      state: 'error',
      isAI: null,
      score: null,
      provider: 'client-ai-check',
      message,
      checkedAt: new Date().toISOString(),
    });

    const ensureHiddenInput = (name: string) => {
      let input = form.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        form.appendChild(input);
      }
      return input;
    };

    const renderStatus = (message: string, state: 'pending' | 'checked' | 'error') => {
      if (!statusNode) return;
      statusNode.hidden = false;
      statusNode.textContent = message;
      statusNode.dataset.state = state;
    };

    const setAiCheckPayload = (payload: Record<string, unknown>) => {
      ensureHiddenInput('aiCheckPayload').value = JSON.stringify(payload);
    };

    const hasSelectedUploadFile = () => {
      const input = form.querySelector('input[type="file"][name="file"]') as HTMLInputElement | null;
      return !!input?.files?.length;
    };

    const finalizeSubmit = () => {
      form.dataset.aiCheckInFlight = 'false';
      form.dataset.aiCheckReady = 'true';
      form.submit();
    };

    $(form).on('submit', async (ev) => {
      if (form.dataset.aiCheckReady === 'true') return;
      ev.preventDefault();
      if (form.dataset.aiCheckInFlight === 'true') return;
      form.dataset.aiCheckInFlight = 'true';
      setAiCheckPayload(buildFallbackPayload('Pending'));
      renderStatus('Pending', 'pending');

      if (hasSelectedUploadFile()) {
        const payload = {
          state: 'pending',
          isAI: null,
          score: null,
          provider: 'post-accepted-ai-check',
          message: 'AI check deferred because this submission was uploaded as a file.',
          checkedAt: new Date().toISOString(),
        };
        setAiCheckPayload(payload);
        renderStatus(payload.message, 'pending');
        finalizeSubmit();
        return;
      }

      try {
        const res = await request.postFile(UiContext.aiCheckUrl, new FormData(form));
        const aiCheck = (res?.aiCheck && typeof res.aiCheck === 'object')
          ? res.aiCheck
          : buildFallbackPayload('AI check API returned an invalid response.');
        const state = aiCheck.state === 'pending'
          ? 'pending'
          : aiCheck.state === 'error'
            ? 'error'
            : 'checked';
        setAiCheckPayload(aiCheck);
        renderStatus(aiCheck.message || 'AI check completed.', state);
      } catch (error) {
        const message = error instanceof Error
          ? `AI check failed before submit. It will retry after submit. ${error.message}`
          : 'AI check failed before submit. It will retry after submit.';
        setAiCheckPayload(buildFallbackPayload(message));
        renderStatus(message, 'error');
        Notification.error(message);
      } finally {
        finalizeSubmit();
      }
    });
  }

  if (localStorage.getItem('submit-hint') === 'dismiss') return;
  $(tpl`<div name="hint" class="typo"></div>`).prependTo('[name="submit_section"]');
  const root = ReactDOM.createRoot(document.querySelector('[name="hint"]'));
  function ignore() {
    root.unmount();
    localStorage.setItem('submit-hint', 'dismiss');
  }

  root.render(<blockquote className="note">
    <p>{i18n('This page is only for pasting code from other sources.')}</p>
    <p>{i18n("To get a better editing experience, with code highlighting and test runs, \
please go back to the problem detail page and use 'Open Scratchpad' button.")}
    </p>
    <a onClick={() => root.unmount()}>{i18n('Dismiss')}</a> / <a onClick={ignore}>{i18n("Don't show again")}</a>
  </blockquote>);
});

export default page;
