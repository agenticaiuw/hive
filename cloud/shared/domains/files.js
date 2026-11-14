/*
 * The files capability domain: reading, writing, moving and tidying the Mac's
 * folders — and the places the owner's work actually lives.
 */
export default Object.freeze({
  name: 'files',
  what: 'Files and folders: read, write, search, move, tidy — and where the owner keeps things.',

  tools: Object.freeze({
    exact: Object.freeze([
      'read_file',
      'write_file',
      'list_directory',
      'delete_path',
      'copy_path',
      'move_path',
      'open_path',
      'open_folder',
      'create_note',
      'search_file',
      'run_project',
    ]),
    prefixes: Object.freeze(['sweep_folder_', 'tidy_downloads_']),
  }),

  /*
   * Fact names under dom.files.*:
   *   place.<label>  — a directory the owner's work goes into
   *   place.default  — where new files go when they do not say
   *   task.<slug>    — a repeated file-work shape
   *
   * Paths are this Mac's paths, so file places default to node scope: a
   * browser in another room cannot open ~/Notes and should not be told about
   * it as if it could.
   */
  capture: Object.freeze([
    Object.freeze({
      id: 'files.place-from-action',
      action: 'write_file',
      param: 'path',
      /* The directory, not the file: the reusable connection is the place. */
      name: (value) => `place.${String(value).split('/').slice(-2, -1)[0] || 'root'}`,
      value: (raw) => String(raw).split('/').slice(0, -1).join('/') || '/',
      scope: 'node',
    }),
  ]),

  clarify: Object.freeze([
    Object.freeze({
      id: 'files.place',
      trigger: /\b(save|file|put|store)\b.*\b(note|file|document|doc)s?\b/i,
      distinguisher: 'place',
      ask: (labels) => `Where should I put it — ${labels.join(', ')}?`,
    }),
  ]),
})
