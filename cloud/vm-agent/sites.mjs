// Site recipes: where a post goes, how its composer is found, and what counts as proof it was sent.
// Every function under `page` runs inside the browser page and must be self-contained.
//
// The Discord and X selectors describe those sites' public web clients. They are the part most
// likely to drift; a recipe that cannot find or read back its composer stops before submitting.

export const normalizeText = text => String(text)
  .replace(/\r\n?/g, '\n').replace(/[﻿​]/g, '').replace(/ /g, ' ')
  .split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');

const SNOWFLAKE = '\\d{15,22}';

const discord = {
  name: 'discord',
  maxLength: 2000,
  maxAttachments: 10,
  homeUrl: 'https://discord.com/channels/@me',
  loginUrl: 'https://discord.com/login',
  allowedHosts: ['discord.com'],
  newline: { key: 'Enter', modifiers: ['shift'] },
  submit: { key: 'Enter' },
  composer: 'div[role="textbox"][data-slate-editor="true"]',
  fileInput: 'input[type="file"]',
  parseDestination(destination) {
    const match = new RegExp(`^https://discord\\.com/channels/(${SNOWFLAKE}|@me)/(${SNOWFLAKE})/?$`).exec(String(destination));
    if (!match) throw new Error('Discord destination must be a channel link: https://discord.com/channels/<server>/<channel>');
    return { url: `https://discord.com/channels/${match[1]}/${match[2]}`, server: match[1], channel: match[2] };
  },
  page: {
    loggedOut: () => /^\/(login|register)\b/.test(location.pathname) || !!document.querySelector('input[name="password"]'),
    ready: () => !!document.querySelector('div[role="textbox"][data-slate-editor="true"]'),
    label: () => {
      const box = document.querySelector('div[role="textbox"][data-slate-editor="true"]');
      return [document.title, box?.getAttribute('aria-label')].filter(Boolean).join(' — ');
    },
    readComposer: () => {
      const box = document.querySelector('div[role="textbox"][data-slate-editor="true"]');
      if (!box) return null;
      const blocks = [...box.querySelectorAll(':scope > [data-slate-node="element"]')];
      if (!blocks.length) return box.innerText;
      return blocks.map(block => [...block.querySelectorAll('[data-slate-string]')].map(leaf => leaf.textContent).join('')).join('\n');
    },
    blocked: () => {
      const popup = document.querySelector('[class*="autocomplete"]');
      if (popup && popup.getBoundingClientRect().height > 0) return 'an autocomplete menu is open in the composer';
      return null;
    },
    attachmentCount: () => document.querySelectorAll('[class*="channelAttachmentArea"] li, ul[class*="channelAttachmentArea"] > *').length,
    messageIds: () => [...document.querySelectorAll('[id^="message-content-"]')].map(node => node.id),
    // Proof of sending: a message that was not there before, whose text is exactly ours, no longer pending.
    sentProbe: (expected, before, wantAttachments) => {
      const clean = text => text.replace(/\r\n?/g, '\n').replace(/[﻿​]/g, '').replace(/ /g, ' ').split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
      for (const node of document.querySelectorAll('[id^="message-content-"]')) {
        if (before.includes(node.id) || clean(node.innerText.replace(/\s*\(edited\)$/, '')) !== expected) continue;
        const item = node.closest('li') ?? node.parentElement;
        const state = `${node.className} ${item?.className ?? ''}`;
        if (/isSending/i.test(state)) return null;
        if (/isFailed/i.test(state)) return { failed: 'Discord marked the message as failed to send' };
        const id = node.id.replace('message-content-', '');
        if (!/^\d{15,22}$/.test(id)) return null;
        const attachments = item ? item.querySelectorAll('[id^="message-accessories-"] img, [id^="message-accessories-"] video, [id^="message-accessories-"] a[href*="/attachments/"]').length : 0;
        if (wantAttachments && !attachments) return null;
        return { messageId: id, permalink: `${location.origin}${location.pathname.replace(/\/$/, '')}/${id}`, attachments };
      }
      return null;
    },
    // Read-only: list servers, or the channels of the server currently open.
    servers: () => [...document.querySelectorAll('[data-list-item-id^="guildsnav___"]')]
      .map(node => ({ id: node.getAttribute('data-list-item-id').replace('guildsnav___', ''), name: (node.getAttribute('aria-label') ?? '').trim() }))
      .filter(entry => /^\d{15,22}$/.test(entry.id)),
    channels: () => [...document.querySelectorAll('a[data-list-item-id^="channels___"]')]
      .map(node => ({ id: node.getAttribute('data-list-item-id').replace('channels___', ''), name: (node.getAttribute('aria-label') ?? node.textContent ?? '').trim(), href: node.href }))
      .filter(entry => /^\d{15,22}$/.test(entry.id)),
  },
};

const x = {
  name: 'x',
  maxLength: 280,
  maxAttachments: 4,
  homeUrl: 'https://x.com/home',
  loginUrl: 'https://x.com/i/flow/login',
  allowedHosts: ['x.com'],
  linkHosts: ['x.com', 'twitter.com'],
  newline: { key: 'Enter', modifiers: [] },
  submit: { click: 'button[data-testid="tweetButton"]:not([aria-disabled="true"])' },
  composer: 'div[data-testid="tweetTextarea_0"]',
  fileInput: 'input[data-testid="fileInput"]',
  parseDestination(destination) {
    if (destination === 'post' || destination === 'https://x.com/compose/post') return { url: 'https://x.com/compose/post', kind: 'post' };
    throw new Error('X destination must be "post" (a new post on your own timeline)');
  },
  page: {
    loggedOut: () => /^\/(i\/flow\/login|login)\b/.test(location.pathname) || !!document.querySelector('input[autocomplete="username"]'),
    ready: () => !!document.querySelector('div[data-testid="tweetTextarea_0"]'),
    label: () => `New post — ${document.title}`,
    readComposer: () => {
      const box = document.querySelector('div[data-testid="tweetTextarea_0"]');
      if (!box) return null;
      const blocks = [...box.querySelectorAll('[data-block="true"]')];
      if (!blocks.length) return box.innerText;
      return blocks.map(block => [...block.querySelectorAll('[data-text="true"]')].map(leaf => leaf.textContent).join('')).join('\n');
    },
    blocked: () => (document.querySelector('[data-testid="typeaheadDropdown"], [id^="typeaheadDropdown"]') ? 'a suggestion menu is open in the composer' : null),
    attachmentCount: () => document.querySelectorAll('[data-testid="attachments"] img, [data-testid="attachments"] video').length,
    messageIds: () => [],
    // Proof of sending: X's own confirmation toast linking to the new post.
    sentProbe: () => {
      const link = document.querySelector('[data-testid="toast"] a[href*="/status/"]');
      if (!link) return null;
      const id = /\/status\/(\d+)/.exec(link.href)?.[1];
      return id ? { messageId: id, permalink: link.href } : null;
    },
  },
};

export const RECIPES = { discord, x };

export function recipeFor(platform, extra = {}) {
  const recipe = { ...RECIPES, ...extra }[platform];
  if (!recipe) throw new Error(`unsupported platform: ${platform}`);
  return recipe;
}

export function validatePost(recipe, { destination, text, attachments = [] }) {
  if (typeof text !== 'string') throw new Error('text must be a string');
  const body = normalizeText(text);
  if (!body.length) throw new Error('text is required');
  if ([...body].length > recipe.maxLength) throw new Error(`text is ${[...body].length} characters; ${recipe.name} allows ${recipe.maxLength}`);
  if (attachments.length > recipe.maxAttachments) throw new Error(`${recipe.name} allows ${recipe.maxAttachments} attachments`);
  return { target: recipe.parseDestination(destination), text: body };
}

// A link the owner pastes into the viewer (such as a "verify this login" email link) may only
// lead to a site the worker knows, or one of its subdomains, over https.
export function ownedLink(value, recipes = RECIPES) {
  let link;
  try { link = new URL(String(value).trim()); } catch { throw new Error('not a link'); }
  const hosts = Object.values(recipes).flatMap(site => site.linkHosts ?? site.allowedHosts);
  if (link.protocol !== 'https:' || link.username || link.password || !hosts.some(host => link.hostname === host || link.hostname.endsWith(`.${host}`))) {
    throw new Error('only https links to a known site open here');
  }
  return link.href;
}
