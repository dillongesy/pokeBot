'use strict';

/**
 * A stand-in for a Discord channel, so the website can run the bot's own
 * commands unchanged.
 *
 * Commands talk to Discord through a small surface: `channel.send`,
 * `message.edit`, and button collectors on the messages they send. This
 * module implements that surface in memory. Whatever a command posts is kept
 * here and pushed to the player's browser; a button pressed in the browser
 * comes back as a press on the same collector Discord would have fed.
 *
 * Because the real command code runs, everything stays in step with Discord:
 * the same drop cooldown (in the database), the same "already in a battle"
 * check (Commands/battle.js `active`, in this same process), the same party
 * lock, rewards and quests.
 *
 * Each player has one channel per station ("drop", "battle"), with the id
 * `web:<userId>:<station>`. Only that player can see or press anything in it.
 */

const { EventEmitter } = require('events');
const { Collection, MessageFlags } = require('discord.js');

/** Messages kept per channel, oldest dropped first. */
const KEEP = 25;

/** Every message id handed out, so they never collide with Discord's. */
let nextId = 1;

/** channelId -> VirtualChannel */
const channels = new Map();

/** Anything with a toJSON (builders) becomes plain JSON. */
const plain = (value) => (value && typeof value.toJSON === 'function' ? value.toJSON() : value);

/** A file in a payload: an AttachmentBuilder, { attachment, name }, or a path. */
function fileOf(file) {
  if (typeof file === 'string') return { data: file, name: file.split(/[\\/]/).pop() };
  return { data: file.attachment, name: file.name || 'file' };
}

class VirtualCollector extends EventEmitter {
  constructor(message, { filter = null, time = null, idle = null, max = null } = {}) {
    super();
    this.message = message;
    this.filter = filter;
    this.max = max;
    this.idle = idle;
    this.collected = new Collection();
    this.ended = false;
    this.timer = time ? setTimeout(() => this.stop('time'), time) : null;
    this.idleTimer = null;
    this.resetIdle();
  }

  resetIdle() {
    if (!this.idle) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop('idle'), this.idle);
  }

  resetTimer({ time, idle } = {}) {
    if (time) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.stop('time'), time);
    }
    if (idle) this.idle = idle;
    this.resetIdle();
  }

  /** Offer a press. Returns whether this collector took it. */
  async offer(press) {
    if (this.ended) return false;
    if (this.filter && !(await this.filter(press))) return false;

    this.collected.set(press.id, press);
    this.resetIdle();
    this.emit('collect', press);

    if (this.max && this.collected.size >= this.max) this.stop('limit');
    return true;
  }

  stop(reason = 'user') {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
    this.message.collectors.delete(this);
    this.emit('end', this.collected, reason);
  }
}

class VirtualMessage {
  constructor(channel, payload) {
    this.id = `web-${nextId++}`;
    this.channel = channel;
    this.channelId = channel.id;
    this.guildId = null;
    this.client = channel.client;
    this.collectors = new Set();
    this.createdAt = Date.now();
    this.content = '';
    this.embeds = [];
    this.components = [];
    this.files = [];
    this.ephemeral = false;
    this.deleted = false;
    this.apply(payload, true);
  }

  /** Discord's rules for what a send or an edit replaces. */
  apply(payload, fresh = false) {
    if (typeof payload === 'string') payload = { content: payload };
    payload = payload || {};

    if ('content' in payload) this.content = payload.content || '';
    if ('embeds' in payload) this.embeds = (payload.embeds || []).map(plain);
    if ('components' in payload) this.components = (payload.components || []).map(plain);

    // Existing files stay unless `attachments` says otherwise; new ones add.
    if ('attachments' in payload) this.files = [];
    if (payload.files) this.files = [...(fresh ? [] : this.files), ...payload.files.map(fileOf)];

    if (fresh && payload.flags && (Number(payload.flags) & MessageFlags.Ephemeral)) this.ephemeral = true;
  }

  async edit(payload) {
    if (this.deleted) throw new Error('Unknown Message');
    this.apply(payload);
    this.channel.changed(this);
    return this;
  }

  async delete() {
    this.deleted = true;
    for (const collector of [...this.collectors]) collector.stop('messageDelete');
    this.channel.removed(this);
    return this;
  }

  createMessageComponentCollector(options = {}) {
    const collector = new VirtualCollector(this, options);
    this.collectors.add(collector);
    return collector;
  }

  /** One matching press, or a rejection after `time`. */
  awaitMessageComponent({ filter = null, time = null } = {}) {
    return new Promise((resolve, reject) => {
      const collector = this.createMessageComponentCollector({ filter, time, max: 1 });
      collector.once('end', (collected, reason) => {
        const first = collected.first();
        if (first) resolve(first);
        else reject(Object.assign(new Error(`Collector received no interactions before ending with reason: ${reason}`), { code: 'InteractionCollectorError' }));
      });
    });
  }

  /** What the browser gets. Files become links; their paths stay here. */
  toJSON() {
    const fileUrl = (index) => `/api/file/${this.channel.station}/${this.id}/${index}`;
    const byName = new Map(this.files.map((file, index) => [file.name, fileUrl(index)]));

    // `attachment://name` in an embed points at one of this message's files.
    // Linked by position so a file name (often the Pokemon's) never reaches
    // the page.
    const link = (url) => {
      if (typeof url !== 'string' || !url.startsWith('attachment://')) return url;
      return byName.get(url.slice('attachment://'.length)) || null;
    };

    const embeds = this.embeds.map((embed) => ({
      ...embed,
      image: embed.image ? { url: link(embed.image.url) } : undefined,
      thumbnail: embed.thumbnail ? { url: link(embed.thumbnail.url) } : undefined,
    }));

    const shown = new Set(embeds.flatMap((e) => [e.image && e.image.url, e.thumbnail && e.thumbnail.url]));

    return {
      id: this.id,
      at: this.createdAt,
      content: this.content,
      embeds,
      components: this.components,
      ephemeral: this.ephemeral,
      // Files not already shown in an embed (the battle log's text file).
      files: this.files
        .map((file, index) => ({ name: file.name.endsWith('.txt') ? file.name : 'file', url: fileUrl(index) }))
        .filter((file) => !shown.has(file.url)),
    };
  }
}

/** A button press from the browser, shaped like a discord.js interaction. */
function pressOn(message, user, customId, values = []) {
  const channel = message.channel;
  let replied = false;

  return {
    id: `press-${nextId++}`,
    customId,
    values,
    user,
    member: { displayName: user.globalName || user.username, user },
    message,
    channel,
    channelId: channel.id,
    guildId: null,
    client: channel.client,
    isButton: () => true,
    isStringSelectMenu: () => values.length > 0,
    get replied() { return replied; },
    deferred: false,
    async deferUpdate() {},
    async update(payload) { replied = true; return message.edit(payload); },
    async editReply(payload) { replied = true; return message.edit(payload); },
    async reply(payload) { replied = true; return channel.send(payload); },
    async followUp(payload) { return channel.send(payload); },
  };
}

class VirtualChannel extends EventEmitter {
  constructor(user, station, client) {
    super();
    this.user = user;
    this.station = station;
    this.id = `web:${user.id}:${station}`;
    this.client = client;
    this.guild = null;
    this.guildId = null;
    this.messages = [];
  }

  isTextBased() { return true; }
  isDMBased() { return false; }
  async sendTyping() {}

  async send(payload) {
    const message = new VirtualMessage(this, payload);
    this.messages.push(message);

    // Forget the oldest, and stop anything still listening to it.
    while (this.messages.length > KEEP) {
      const old = this.messages.shift();
      for (const collector of [...old.collectors]) collector.stop('messageDelete');
    }

    this.emit('update', { type: 'message', station: this.station, message: message.toJSON() });
    return message;
  }

  changed(message) {
    if (this.messages.includes(message)) {
      this.emit('update', { type: 'message', station: this.station, message: message.toJSON() });
    }
  }

  removed(message) {
    this.messages = this.messages.filter((m) => m !== message);
    this.emit('update', { type: 'remove', station: this.station, id: message.id });
  }

  find(messageId) {
    return this.messages.find((m) => m.id === messageId) || null;
  }

  /**
   * A press from the browser. Answered by the first collector that takes it,
   * as Discord would; returns false when nothing is listening any more.
   */
  async press(messageId, customId, values = []) {
    const message = this.find(messageId);
    if (!message) return false;

    const press = pressOn(message, this.user, customId, values);
    for (const collector of [...message.collectors]) {
      if (await collector.offer(press)) return true;
    }
    return false;
  }

  /** A message from the player, shaped like discord.js's. For commands and catching. */
  messageFrom(text) {
    const user = this.user;
    return {
      id: `web-${nextId++}`,
      content: text,
      author: user,
      member: { displayName: user.globalName || user.username, user },
      channel: this,
      channelId: this.id,
      guild: null,
      guildId: null,
      client: this.client,
      mentions: { users: new Collection(), members: new Collection(), roles: new Collection(), channels: new Collection() },
      reply: (payload) => this.send(payload),
    };
  }

  clear() {
    for (const message of this.messages) {
      for (const collector of [...message.collectors]) collector.stop('messageDelete');
    }
    this.messages = [];
    this.emit('update', { type: 'clear', station: this.station });
  }
}

/** A user object close enough to discord.js's for the commands. */
function userFrom({ id, username, globalName = null, avatar = null }) {
  return {
    id: String(id),
    username,
    globalName,
    tag: username,
    bot: false,
    avatar,
    displayAvatarURL: () =>
      avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=128` : 'https://cdn.discordapp.com/embed/avatars/0.png',
    toString: () => `<@${id}>`,
  };
}

/** The player's channel for one station, made on first use. */
function channelFor(user, station, client) {
  const id = `web:${user.id}:${station}`;
  let channel = channels.get(id);
  if (!channel) {
    channel = new VirtualChannel(userFrom(user), station, client);
    channels.set(id, channel);
  }
  return channel;
}

module.exports = { channelFor, userFrom, VirtualChannel, VirtualMessage, KEEP };
