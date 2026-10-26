// Message files: one folder per language with the same namespace files (English is the reference).
// `npm run check:locales` reports missing or extra keys and placeholder mismatches.

import en_app from './en/app.json';
import en_common from './en/common.json';
import en_core from './en/core.json';
import en_export from './en/export.json';
import en_main from './en/main.json';
import en_sources from './en/sources.json';
import en_summary from './en/summary.json';
import en_sync from './en/sync.json';
import en_template from './en/template.json';
import en_track from './en/track.json';
import en_values from './en/values.json';
import en_videos from './en/videos.json';
import en_web from './en/web.json';
import es_app from './es/app.json';
import es_common from './es/common.json';
import es_core from './es/core.json';
import es_export from './es/export.json';
import es_main from './es/main.json';
import es_sources from './es/sources.json';
import es_summary from './es/summary.json';
import es_sync from './es/sync.json';
import es_template from './es/template.json';
import es_track from './es/track.json';
import es_values from './es/values.json';
import es_videos from './es/videos.json';
import es_web from './es/web.json';
import it_app from './it/app.json';
import it_common from './it/common.json';
import it_core from './it/core.json';
import it_export from './it/export.json';
import it_main from './it/main.json';
import it_sources from './it/sources.json';
import it_summary from './it/summary.json';
import it_sync from './it/sync.json';
import it_template from './it/template.json';
import it_track from './it/track.json';
import it_values from './it/values.json';
import it_videos from './it/videos.json';
import it_web from './it/web.json';
import ja_app from './ja/app.json';
import ja_common from './ja/common.json';
import ja_core from './ja/core.json';
import ja_export from './ja/export.json';
import ja_main from './ja/main.json';
import ja_sources from './ja/sources.json';
import ja_summary from './ja/summary.json';
import ja_sync from './ja/sync.json';
import ja_template from './ja/template.json';
import ja_track from './ja/track.json';
import ja_values from './ja/values.json';
import ja_videos from './ja/videos.json';
import ja_web from './ja/web.json';
import ptBR_app from './pt-BR/app.json';
import ptBR_common from './pt-BR/common.json';
import ptBR_core from './pt-BR/core.json';
import ptBR_export from './pt-BR/export.json';
import ptBR_main from './pt-BR/main.json';
import ptBR_sources from './pt-BR/sources.json';
import ptBR_summary from './pt-BR/summary.json';
import ptBR_sync from './pt-BR/sync.json';
import ptBR_template from './pt-BR/template.json';
import ptBR_track from './pt-BR/track.json';
import ptBR_values from './pt-BR/values.json';
import ptBR_videos from './pt-BR/videos.json';
import ptBR_web from './pt-BR/web.json';

export const MESSAGES = {
  en: {
    common: en_common,
    app: en_app,
    main: en_main,
    videos: en_videos,
    sources: en_sources,
    summary: en_summary,
    sync: en_sync,
    track: en_track,
    template: en_template,
    values: en_values,
    export: en_export,
    core: en_core,
    web: en_web,
  },
  'pt-BR': {
    common: ptBR_common,
    app: ptBR_app,
    main: ptBR_main,
    videos: ptBR_videos,
    sources: ptBR_sources,
    summary: ptBR_summary,
    sync: ptBR_sync,
    track: ptBR_track,
    template: ptBR_template,
    values: ptBR_values,
    export: ptBR_export,
    core: ptBR_core,
    web: ptBR_web,
  },
  es: {
    common: es_common,
    app: es_app,
    main: es_main,
    videos: es_videos,
    sources: es_sources,
    summary: es_summary,
    sync: es_sync,
    track: es_track,
    template: es_template,
    values: es_values,
    export: es_export,
    core: es_core,
    web: es_web,
  },
  it: {
    common: it_common,
    app: it_app,
    main: it_main,
    videos: it_videos,
    sources: it_sources,
    summary: it_summary,
    sync: it_sync,
    track: it_track,
    template: it_template,
    values: it_values,
    export: it_export,
    core: it_core,
    web: it_web,
  },
  ja: {
    common: ja_common,
    app: ja_app,
    main: ja_main,
    videos: ja_videos,
    sources: ja_sources,
    summary: ja_summary,
    sync: ja_sync,
    track: ja_track,
    template: ja_template,
    values: ja_values,
    export: ja_export,
    core: ja_core,
    web: ja_web,
  },
} as const;
