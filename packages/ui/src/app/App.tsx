import { nextStep, previousStep, type StepId, type StepStatus } from '@custom-overlay/core';
import { type ComponentType, useEffect, useState } from 'react';
import type { AppInfo } from '../shared/api';
import { api } from './api';
import { BusyMask } from './components/BusyMask';
import { LanguagePicker } from './components/LanguagePicker';
import { NewProjectDialog } from './components/NewProjectDialog';
import { UpdateDialog } from './components/UpdateDialog';
import { coreText, useT } from './i18n';
import logoUrl from './logo.svg';
import { ExportStep } from './steps/ExportStep';
import { SourcesStep } from './steps/SourcesStep';
import { SummaryStep } from './steps/SummaryStep';
import { SyncStep } from './steps/SyncStep';
import { TemplateStep } from './steps/TemplateStep';
import { TrackStep } from './steps/TrackStep';
import { VideosStep } from './steps/VideosStep';
import { isBusy, useStore, useWorkflow } from './store';

const STEP_COMPONENTS: Record<StepId, ComponentType> = {
  videos: VideosStep,
  sources: SourcesStep,
  sync: SyncStep,
  track: TrackStep,
  template: TemplateStep,
  summary: SummaryStep,
  export: ExportStep,
};

const STATE_ICONS: Record<StepStatus['state'], string> = {
  complete: '✓',
  incomplete: '•',
  skipped: '–',
  'not-applicable': '–',
};

function Stepper({ workflow, current }: { workflow: StepStatus[]; current: StepId }) {
  const t = useT();
  const goTo = useStore((s) => s.goTo);
  return (
    <nav className="stepper">
      {workflow.map((step, index) => {
        const hasError = step.issues.some((i) => i.severity === 'error');
        return (
          <button
            type="button"
            key={step.id}
            className={`step-item ${step.id === current ? 'active' : ''} ${step.reachable ? step.state : ''} ${hasError ? 'has-error' : ''}`}
            disabled={!step.reachable}
            onClick={() => goTo(step.id)}
            title={
              step.issues.map((i) => coreText.issue(t, i)).join('\n') || coreText.stepDescription(t, step)
            }
          >
            <span className="step-index">
              {step.state === 'complete' && step.reachable ? STATE_ICONS.complete : index + 1}
            </span>
            <span className="step-text">
              <span className="step-title">{coreText.stepTitle(t, step)}</span>
              <span className="step-state">
                {step.optional && step.state !== 'complete'
                  ? t('common.optional')
                  : t(`app.stepState.${step.state}`)}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function Toolbar() {
  const t = useT();
  const name = useStore((s) => s.project.name);
  const dirty = useStore((s) => s.dirty);
  const projectPath = useStore((s) => s.projectPath);
  const setName = useStore((s) => s.setName);
  const requestNewProject = useStore((s) => s.requestNewProject);
  const openProject = useStore((s) => s.openProject);
  const saveProject = useStore((s) => s.saveProject);

  useEffect(() => {
    document.title = `${name}${dirty ? ' •' : ''} — Custom Overlay`;
  }, [name, dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Opening or saving while media loads or an export runs would race with it.
      if (!(e.ctrlKey || e.metaKey) || isBusy(useStore.getState())) return;
      if (e.key === 's') {
        e.preventDefault();
        void saveProject(e.shiftKey);
      } else if (e.key === 'o') {
        e.preventDefault();
        void openProject();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveProject, openProject]);

  const confirmDiscard = () => !dirty || window.confirm(t('app.toolbar.confirmDiscard'));

  return (
    <header className="toolbar">
      <div className="brand">
        <img className="logo" src={logoUrl} alt="" /> Custom Overlay
      </div>
      <input
        type="text"
        className="project-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        title={projectPath ?? t('app.toolbar.unsavedProject')}
      />
      {dirty && (
        <span className="dirty" title={t('app.toolbar.unsavedChanges')}>
          ●
        </span>
      )}
      <div className="spacer" />
      <button type="button" onClick={() => confirmDiscard() && requestNewProject()}>
        {t('app.toolbar.new')}
      </button>
      <button type="button" onClick={() => confirmDiscard() && void openProject()}>
        {t('app.toolbar.open')}
      </button>
      <button type="button" onClick={() => void saveProject()}>
        {t('common.save')}
      </button>
      <button type="button" onClick={() => void saveProject(true)}>
        {t('app.toolbar.saveAs')}
      </button>
      <LanguagePicker />
    </header>
  );
}

/** First year of the copyright notice. */
const COPYRIGHT_SINCE = 2026;

/** Name, version and author of the app, linking to the project page. */
function AboutLine() {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api().appInfo().then(setInfo);
  }, []);
  if (!info) return null;
  const year = new Date().getFullYear();
  const years = year > COPYRIGHT_SINCE ? `${COPYRIGHT_SINCE}–${year}` : String(COPYRIGHT_SINCE);
  return (
    <button
      type="button"
      className="link about-line"
      title={t('app.footer.projectPage')}
      onClick={() => void api().openProjectUrl(info.homepage)}
    >
      {info.name} {info.version} · © {years} {info.author}
    </button>
  );
}

function Footer({ workflow, current }: { workflow: StepStatus[]; current: StepId }) {
  const t = useT();
  const goTo = useStore((s) => s.goTo);
  const prev = previousStep(current);
  const next = nextStep(current);
  const status = workflow.find((s) => s.id === current);
  const nextStatus = workflow.find((s) => s.id === next);
  const firstError = status?.issues.find((i) => i.severity === 'error');
  const hint = firstError ?? status?.issues[0];
  const skippable = status?.optional && status.state !== 'complete';

  return (
    <footer className="footer">
      <button type="button" disabled={!prev} onClick={() => prev && goTo(prev)}>
        ← {t('app.footer.back')}
      </button>
      <div className="footer-center">
        {hint && (
          <span className={`footer-hint ${firstError ? 'error-text' : 'muted'}`}>
            {coreText.issue(t, hint)}
          </span>
        )}
        <AboutLine />
      </div>
      {next && (
        <button
          type="button"
          className="primary"
          disabled={!nextStatus?.reachable}
          onClick={() => goTo(next)}
        >
          {skippable ? t('app.footer.skip') : t('app.footer.next')} →
        </button>
      )}
    </footer>
  );
}

function Notice() {
  const t = useT();
  const notice = useStore((s) => s.notice);
  const dismiss = useStore((s) => s.dismissNotice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);
  if (!notice) return null;
  return (
    <div className={`notice ${notice.kind}`} role="alert">
      {notice.message}
      <button type="button" className="link" onClick={dismiss} aria-label={t('common.close')}>
        ×
      </button>
    </div>
  );
}

let startupHandled = false;

export function App() {
  const step = useStore((s) => s.step);
  const openProject = useStore((s) => s.openProject);
  const requestNewProject = useStore((s) => s.requestNewProject);
  const loadTrackCatalog = useStore((s) => s.loadTrackCatalog);
  const workflow = useWorkflow();

  useEffect(() => {
    if (startupHandled) return;
    startupHandled = true;
    void loadTrackCatalog();
    // Without a project file on the command line, start by naming a new project.
    void api()
      .getStartupProject()
      .then((opened) => (opened ? openProject(opened) : requestNewProject('startup')));
  }, [openProject, requestNewProject, loadTrackCatalog]);

  const StepComponent = STEP_COMPONENTS[step];
  return (
    <div className="app">
      <Toolbar />
      <div className="body">
        <Stepper workflow={workflow} current={step} />
        <main className="content">
          <StepComponent />
        </main>
      </div>
      <Footer workflow={workflow} current={step} />
      <Notice />
      <NewProjectDialog />
      <UpdateDialog />
      <BusyMask />
    </div>
  );
}
