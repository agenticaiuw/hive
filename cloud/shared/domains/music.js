/*
 * The music/audio capability domain: playback, and what the owner likes to
 * hear and where they like it played from.
 */
export default Object.freeze({
  name: 'music',
  what: 'Music and audio playback, and the services and playlists the owner actually uses.',

  tools: Object.freeze({
    exact: Object.freeze(['play_youtube']),
    prefixes: Object.freeze(['music_']),
  }),

  /*
   * Fact names under dom.music.*:
   *   service.default — where playback requests go when they do not say
   *   artist.<slug>   — an act the owner has actually asked for
   */
  capture: Object.freeze([
    Object.freeze({
      id: 'music.service-from-action',
      action: 'play_youtube',
      param: null,
      name: () => 'service.default',
      value: () => 'youtube',
      scope: 'hive',
    }),
  ]),

  clarify: Object.freeze([
    Object.freeze({
      id: 'music.service',
      trigger: /\b(play|music|song|album|playlist)\b/i,
      distinguisher: 'service',
      ask: (labels) => `Play it where — ${labels.join(', ')}?`,
    }),
  ]),
})
