import { useEffect, useMemo, useRef, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DeviceCodeSignInPrompt } from '@/components/DeviceCodeSignInPrompt';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { InstalledPluginSummary as PluginSummary, SessionRequirement } from '../../../electron/shared/ipcContracts';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { useJob } from '../hooks/useJob';

type WizardStep = 'sourceConnect' | 'destinationConnect' | 'configure';

/** One clickable option on the "what and how" screen — a plugin's own `SessionRequirement`
 * expanded into a fresh-connect row (always shown) and, only when at least one compatible session
 * already exists, a reuse row. A plugin with more than one `sessionRequirements` entry (e.g. Azure
 * Billing's device-code and enterprise-app options) gets one independent pair of rows per
 * requirement — confirmed with the user as the intended shape, not a dropdown. */
type ConnectRow =
  | { kind: 'fresh'; plugin: PluginSummary; requirement: SessionRequirement }
  | { kind: 'reuse'; plugin: PluginSummary; requirement: SessionRequirement; sessions: Session[] };

function compatibleSessionsFor(plugin: PluginSummary, sessions: Session[], requirement: SessionRequirement): Session[] {
  return sessions.filter((s) => s.sessionTypeId === requirement.sessionTypeId && (requirement.confirmsBuiltIn || s.createdByPluginId === plugin.manifest.id));
}

function buildConnectRows(plugins: PluginSummary[], sessions: Session[]): ConnectRow[] {
  const rows: ConnectRow[] = [];
  for (const plugin of plugins) {
    for (const requirement of plugin.sessionRequirements) {
      rows.push({ kind: 'fresh', plugin, requirement });
      if (requirement.allowSessionReuse === false) continue;
      const compatible = compatibleSessionsFor(plugin, sessions, requirement);
      if (compatible.length > 0) rows.push({ kind: 'reuse', plugin, requirement, sessions: compatible });
    }
  }
  return rows;
}

/** "Collect {collects}, {how}" for a source, "Save invoices {collects}, {how}" for a destination
 * — same `collects` field, phrased contextually by whichever sentence its own kind completes (per
 * the confirmed two-screen design). A reuse row's "how" is always this fixed, core-generated
 * phrase, never anything the plugin itself supplies. */
function connectRowLabel(row: ConnectRow, sentence: (collects: string, how: string) => string): string {
  const how = row.kind === 'fresh' ? row.requirement.connectHow : 'reusing existing authentication.';
  return sentence(row.requirement.collects, how);
}

const sourceSentence = (collects: string, how: string) => `Collect ${collects}, ${how}`;
const destinationSentence = (collects: string, how: string) => `Save invoices ${collects}, ${how}`;

function sessionLabelById(sessions: Session[], sessionId: string): string | undefined {
  return sessions.find((s) => s.id === sessionId)?.label;
}

interface ResolvedConnection {
  plugin: PluginSummary;
  requirement: SessionRequirement;
  sessionId: string;
}

interface ConnectButtonListProps {
  rows: ConnectRow[];
  sentence: (collects: string, how: string) => string;
  onFresh: (plugin: PluginSummary, requirement: SessionRequirement) => void;
  onReuse: (row: ConnectRow & { kind: 'reuse' }) => void;
}

function ConnectButtonList({ rows, sentence, onFresh, onReuse }: ConnectButtonListProps) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) =>
        row.kind === 'fresh' ? (
          <Button
            key={`fresh:${row.plugin.manifest.id}:${row.requirement.sessionTypeId}`}
            type="button"
            variant="outline"
            className="h-auto justify-start whitespace-normal text-left"
            onClick={() => onFresh(row.plugin, row.requirement)}
          >
            {connectRowLabel(row, sentence)}
          </Button>
        ) : (
          <Button
            key={`reuse:${row.plugin.manifest.id}:${row.requirement.sessionTypeId}`}
            type="button"
            variant="secondary"
            className="h-auto justify-start whitespace-normal text-left"
            onClick={() => onReuse(row)}
          >
            {connectRowLabel(row, sentence)}
          </Button>
        ),
      )}
    </div>
  );
}

interface ReusePickerProps {
  plugin: PluginSummary;
  sessions: Session[];
  onPick: (sessionId: string) => void;
  onCancel: () => void;
}

/** Only shown when a reuse row's compatible-session list has more than one entry — a single match
 * is auto-picked silently by the caller, matching the confirmed design. */
function ReusePicker({ plugin, sessions, onPick, onCancel }: ReusePickerProps) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <p className="text-sm font-medium">Which {plugin.manifest.name} session?</p>
      {sessions.map((s) => (
        <Button key={s.id} type="button" variant="outline" className="h-auto justify-start whitespace-normal text-left" onClick={() => onPick(s.id)}>
          {s.label}
        </Button>
      ))}
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onCancel}>
        Back
      </Button>
    </div>
  );
}

interface ConnectPanelProps {
  plugin: PluginSummary;
  requirement: SessionRequirement;
  /** Fires once, after a freshly-created session has been auto-named (via `SessionLabelSuggester`,
   * silently renamed — never an editable field) and `WizardValueSuggester` has had a chance to
   * pre-fill the later configure step. */
  onConnected: (session: Session, suggestedValues: Record<string, unknown> | undefined) => void;
  onCancel: () => void;
}

/** The "what and how" screen's own connect popup: always shows `connectInstructions`; a
 * `createInputFields` requirement (a pasted-credential plugin) also renders that form and waits
 * for an explicit "Connect" click, while anything else (device-code, browser-captured) starts
 * signing in immediately on mount — there's nothing else to collect first. */
function ConnectPanel({ plugin, requirement, onConnected, onCancel }: ConnectPanelProps) {
  const job = useJob<Session>();
  const [inputValues, setInputValues] = useState<WizardFieldValues>({});
  const [finishing, setFinishing] = useState(false);
  const inputFields = requirement.createInputFields ?? [];
  const hasFields = inputFields.length > 0;
  const inputValid = !hasFields || validateWizardValues(inputFields, inputValues).valid;
  const succeeded = job.result?.ok === true;
  const running = job.jobId !== undefined && !job.result;

  function connect() {
    void job.start(
      window.api.sessionsCreate({
        pluginId: plugin.manifest.id,
        sessionTypeId: requirement.sessionTypeId,
        ...(hasFields ? { input: inputValues } : {}),
      }),
    );
  }

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (hasFields || autoStartedRef.current) return;
    autoStartedRef.current = true;
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!succeeded) return;
    const session = (job.result as { ok: true; result: Session }).result;
    setFinishing(true);
    void Promise.all([
      window.api.sessionsSuggestLabel({ pluginId: plugin.manifest.id, sessionId: session.id }),
      window.api.wizardSuggestValues({ pluginId: plugin.manifest.id, sessionId: session.id }),
    ])
      .then(async ([suggestedLabel, suggestedValues]) => {
        const finalSession =
          suggestedLabel && suggestedLabel !== session.label
            ? await window.api.sessionsRename({ pluginId: plugin.manifest.id, sessionId: session.id, label: suggestedLabel })
            : session;
        onConnected(finalSession, suggestedValues);
      })
      .finally(() => setFinishing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [succeeded]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <p className="text-sm font-medium">{plugin.manifest.name}</p>
      <p className="text-sm text-muted-foreground">{requirement.connectInstructions}</p>

      {hasFields && !succeeded && (
        <WizardSteps
          pluginId={plugin.manifest.id}
          steps={inputFields}
          values={inputValues}
          onChange={(name, v) => setInputValues((prev) => ({ ...prev, [name]: v }))}
        />
      )}

      {running && <DeviceCodeSignInPrompt progressLog={job.progressLog} />}
      {job.result && !job.result.ok && <p className="text-sm text-destructive">{job.result.error}</p>}
      {finishing && <p className="text-sm text-muted-foreground">Finishing up…</p>}

      {!succeeded && !finishing && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (running) job.cancel();
              onCancel();
            }}
          >
            Back
          </Button>
          {hasFields && (
            <Button type="button" size="sm" disabled={!inputValid || running} onClick={connect}>
              {job.result && !job.result.ok ? 'Retry' : 'Connect'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface AddCollectorWizardProps {
  onClose: () => void;
  onCreated: () => void;
}

/**
 * §14.1's guided "add a collector" flow — a source paired with where it collects to, in one
 * dialog, replacing the plain kind-scoped `AddRecordDialog` for the Collect page's own top-level
 * Add button (Settings' own Sources/Destinations sections keep using the simpler dialog for
 * adding just one thing at a time). Three screens, each a flat list of "what and how" buttons
 * rather than a dropdown-driven form:
 * 1. **Source connect** — one button per (plugin, `SessionRequirement`): "Collect {collects},
 *    {connectHow}" always shown, plus "Collect {collects}, reusing existing authentication." when
 *    a compatible session already exists (silently auto-picked if there's exactly one, else a
 *    small picker). Clicking either resolves the source's session and auto-advances.
 * 2. **Destination connect** — the same pattern (phrased "Save invoices {collects}, …" instead),
 *    plus a button per already-configured destination record to reuse it wholesale.
 * 3. **Configure** — each plugin's own wizard fields, then submit. No manual name fields: the
 *    session's name is whatever `SessionLabelSuggester` returned (silently renamed, never shown as
 *    an editable field); the record's name is computed from `SourceNameSuggester` at submit time,
 *    falling back to the session's own label.
 */
export function AddCollectorWizard({ onClose, onCreated }: AddCollectorWizardProps) {
  const [step, setStep] = useState<WizardStep>('sourceConnect');
  const [sourcePlugins, setSourcePlugins] = useState<PluginSummary[]>([]);
  const [destinationPlugins, setDestinationPlugins] = useState<PluginSummary[]>([]);
  const [existingDestinations, setExistingDestinations] = useState<PluginBackedRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);

  const [sourceFreshTarget, setSourceFreshTarget] = useState<{ plugin: PluginSummary; requirement: SessionRequirement } | undefined>(undefined);
  const [sourceReuseTarget, setSourceReuseTarget] = useState<(ConnectRow & { kind: 'reuse' }) | undefined>(undefined);
  const [sourceConnection, setSourceConnection] = useState<ResolvedConnection | undefined>(undefined);

  const [destinationFreshTarget, setDestinationFreshTarget] = useState<{ plugin: PluginSummary; requirement: SessionRequirement } | undefined>(undefined);
  const [destinationReuseTarget, setDestinationReuseTarget] = useState<(ConnectRow & { kind: 'reuse' }) | undefined>(undefined);
  const [destinationConnection, setDestinationConnection] = useState<ResolvedConnection | undefined>(undefined);
  const [destinationExistingRecord, setDestinationExistingRecord] = useState<PluginBackedRecord | undefined>(undefined);

  const [sourceScope, setSourceScope] = useState('');
  const [sourceName, setSourceName] = useState('');
  // Once the user types into the name field directly, the live suggestion below stops overwriting
  // it — the same "smart default, stops following once edited" pattern a slug-from-title field
  // would use, so an intentional correction never gets silently clobbered by the next keystroke in
  // an unrelated wizard field.
  const [sourceNameEdited, setSourceNameEdited] = useState(false);
  const [sourceValues, setSourceValues] = useState<WizardFieldValues>({});
  const [destinationValues, setDestinationValues] = useState<WizardFieldValues>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void window.api.pluginsList().then((all) => {
      setSourcePlugins(all.filter((p) => p.manifest.kind === 'source'));
      setDestinationPlugins(all.filter((p) => p.manifest.kind === 'destination'));
    });
    void window.api.configListDestinations().then(setExistingDestinations);
    void window.api.sessionsList().then(setSessions);
  }, []);

  const sourceRows = useMemo(() => buildConnectRows(sourcePlugins, sessions), [sourcePlugins, sessions]);
  const destinationRows = useMemo(() => buildConnectRows(destinationPlugins, sessions), [destinationPlugins, sessions]);

  const sourceSubViewActive = sourceFreshTarget !== undefined || sourceReuseTarget !== undefined;
  const destinationSubViewActive = destinationFreshTarget !== undefined || destinationReuseTarget !== undefined;

  function changeSourceConnection() {
    setSourceConnection(undefined);
    setSourceValues({});
    setSourceScope('');
    setSourceName('');
    setSourceNameEdited(false);
  }

  // Live-updates the "Collection name" field with SourceNameSuggester's own best guess as the
  // config wizard's values settle — debounced the same way WizardSteps' own filter fields are
  // (400ms), so a suggestion call doesn't fire on every keystroke of, say, Graph Mail's "Subject
  // contains" field. Stops touching the field entirely once the user has edited it directly.
  useEffect(() => {
    if (!sourceConnection || sourceNameEdited) return;
    const plugin = sourceConnection.plugin;
    const sessionId = sourceConnection.sessionId;
    const fallback = sessionLabelById(sessions, sessionId) ?? plugin.manifest.name;
    const timer = setTimeout(() => {
      void window.api
        .wizardSuggestSourceName({ pluginId: plugin.manifest.id, sessionId, configValues: sourceValues })
        .then((suggested) => setSourceName(suggested ?? fallback))
        .catch(() => setSourceName(fallback));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceConnection, sourceValues, sourceNameEdited]);

  function changeDestinationConnection() {
    setDestinationConnection(undefined);
    setDestinationExistingRecord(undefined);
    setDestinationValues({});
  }

  function handleSourceReuse(row: ConnectRow & { kind: 'reuse' }) {
    if (row.sessions.length === 1) {
      setSourceConnection({ plugin: row.plugin, requirement: row.requirement, sessionId: row.sessions[0].id });
      setStep('destinationConnect');
    } else {
      setSourceReuseTarget(row);
    }
  }

  function handleSourceReusePick(sessionId: string) {
    if (!sourceReuseTarget) return;
    setSourceConnection({ plugin: sourceReuseTarget.plugin, requirement: sourceReuseTarget.requirement, sessionId });
    setSourceReuseTarget(undefined);
    setStep('destinationConnect');
  }

  function handleSourceConnected(session: Session, suggestedValues: Record<string, unknown> | undefined) {
    if (!sourceFreshTarget) return;
    setSessions((prev) => [...prev, session]);
    setSourceConnection({ plugin: sourceFreshTarget.plugin, requirement: sourceFreshTarget.requirement, sessionId: session.id });
    if (suggestedValues) setSourceValues((prev) => ({ ...prev, ...suggestedValues }));
    setSourceFreshTarget(undefined);
    setStep('destinationConnect');
  }

  function handleDestinationReuse(row: ConnectRow & { kind: 'reuse' }) {
    if (row.sessions.length === 1) {
      setDestinationConnection({ plugin: row.plugin, requirement: row.requirement, sessionId: row.sessions[0].id });
      setStep('configure');
    } else {
      setDestinationReuseTarget(row);
    }
  }

  function handleDestinationReusePick(sessionId: string) {
    if (!destinationReuseTarget) return;
    setDestinationConnection({ plugin: destinationReuseTarget.plugin, requirement: destinationReuseTarget.requirement, sessionId });
    setDestinationReuseTarget(undefined);
    setStep('configure');
  }

  function handleDestinationConnected(session: Session, suggestedValues: Record<string, unknown> | undefined) {
    if (!destinationFreshTarget) return;
    setSessions((prev) => [...prev, session]);
    setDestinationConnection({ plugin: destinationFreshTarget.plugin, requirement: destinationFreshTarget.requirement, sessionId: session.id });
    if (suggestedValues) setDestinationValues((prev) => ({ ...prev, ...suggestedValues }));
    setDestinationFreshTarget(undefined);
    setStep('configure');
  }

  function handleReuseExistingDestination(record: PluginBackedRecord) {
    setDestinationExistingRecord(record);
    setStep('configure');
  }

  const canSubmit = sourceConnection !== undefined && (destinationConnection !== undefined || destinationExistingRecord !== undefined);

  async function submit() {
    if (!sourceConnection || !canSubmit) return;
    const sourcePlugin = sourceConnection.plugin;

    const sourceValidation = validateWizardValues(sourcePlugin.wizard, sourceValues);
    if (!sourceValidation.valid) {
      setError(`Missing required source field(s): ${sourceValidation.missingFields.join(', ')}`);
      return;
    }
    if (destinationConnection) {
      const destinationValidation = validateWizardValues(destinationConnection.plugin.wizard, destinationValues);
      if (!destinationValidation.valid) {
        setError(`Missing required destination field(s): ${destinationValidation.missingFields.join(', ')}`);
        return;
      }
    }

    setSubmitting(true);
    setError(undefined);
    try {
      let destinationId: string;
      if (destinationExistingRecord) {
        destinationId = destinationExistingRecord.id;
      } else if (destinationConnection) {
        const destPlugin = destinationConnection.plugin;
        const fallbackName = sessionLabelById(sessions, destinationConnection.sessionId) ?? destPlugin.manifest.name;
        const suggestedName = await window.api.wizardSuggestSourceName({
          pluginId: destPlugin.manifest.id,
          sessionId: destinationConnection.sessionId,
          configValues: destinationValues,
        });
        const created = await window.api.configCreateRecord({
          kind: 'destination',
          pluginId: destPlugin.manifest.id,
          pluginVersion: destPlugin.packageVersion,
          name: suggestedName ?? fallbackName,
          config: destinationValues,
          sessionId: destinationConnection.sessionId,
        });
        destinationId = created.id;
      } else {
        return;
      }

      const sourceFallbackName = sessionLabelById(sessions, sourceConnection.sessionId) ?? sourcePlugin.manifest.name;
      const finalSourceName = sourceName.trim() || sourceFallbackName;

      await window.api.configCreateRecord({
        kind: 'source',
        pluginId: sourcePlugin.manifest.id,
        pluginVersion: sourcePlugin.packageVersion,
        name: finalSourceName,
        config: sourceValues,
        destinationId,
        sessionId: sourceConnection.sessionId,
        scope: sourceScope || undefined,
      });
      toast.success(`${finalSourceName} added`);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const stepNumber = step === 'sourceConnect' ? 1 : step === 'destinationConnect' ? 2 : 3;

  // Closing the wizard without ever reaching a successful submit() (Cancel, Escape, clicking
  // outside) can still leave real state behind: a connect screen may already have signed a
  // brand-new session in, and — if submit() itself got partway through before failing (its own
  // destination-then-source sequence) — a new destination too, neither one ever referenced by the
  // source that would have made them part of a real flow. flowsSweepOrphans() is the same
  // best-effort cleanup used after an edit that changes a flow's destination; it's a no-op when
  // nothing was actually left dangling, so it's safe to always run on the way out.
  async function handleClose() {
    try {
      await window.api.flowsSweepOrphans();
    } catch {
      // Best-effort — a failed cleanup sweep should never block the user from closing the dialog.
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && void handleClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a collector (step {stepNumber} of 3)</DialogTitle>
        </DialogHeader>

        <fieldset disabled={submitting} className="flex flex-col gap-4">
          {step === 'sourceConnect' && (
            <>
              <p className="text-sm font-medium">What and how do you want application to collect?</p>
              {sourceFreshTarget ? (
                <ConnectPanel
                  plugin={sourceFreshTarget.plugin}
                  requirement={sourceFreshTarget.requirement}
                  onConnected={handleSourceConnected}
                  onCancel={() => setSourceFreshTarget(undefined)}
                />
              ) : sourceReuseTarget ? (
                <ReusePicker
                  plugin={sourceReuseTarget.plugin}
                  sessions={sourceReuseTarget.sessions}
                  onPick={handleSourceReusePick}
                  onCancel={() => setSourceReuseTarget(undefined)}
                />
              ) : sourceConnection ? (
                <div className="flex flex-col gap-2 rounded-lg border p-4">
                  <p className="text-sm font-medium">Connected</p>
                  <p className="text-sm text-muted-foreground">
                    Collect {sourceConnection.requirement.collects}, using {sessionLabelById(sessions, sourceConnection.sessionId) ?? 'this session'}.
                  </p>
                  <Button type="button" variant="ghost" size="sm" className="self-start" onClick={changeSourceConnection}>
                    Change connection
                  </Button>
                </div>
              ) : (
                <ConnectButtonList rows={sourceRows} sentence={sourceSentence} onFresh={(plugin, requirement) => setSourceFreshTarget({ plugin, requirement })} onReuse={handleSourceReuse} />
              )}
            </>
          )}

          {step === 'destinationConnect' && (
            <>
              <p className="text-sm font-medium">Where do you want application to save invoices?</p>
              {destinationFreshTarget ? (
                <ConnectPanel
                  plugin={destinationFreshTarget.plugin}
                  requirement={destinationFreshTarget.requirement}
                  onConnected={handleDestinationConnected}
                  onCancel={() => setDestinationFreshTarget(undefined)}
                />
              ) : destinationReuseTarget ? (
                <ReusePicker
                  plugin={destinationReuseTarget.plugin}
                  sessions={destinationReuseTarget.sessions}
                  onPick={handleDestinationReusePick}
                  onCancel={() => setDestinationReuseTarget(undefined)}
                />
              ) : destinationConnection ? (
                <div className="flex flex-col gap-2 rounded-lg border p-4">
                  <p className="text-sm font-medium">Connected</p>
                  <p className="text-sm text-muted-foreground">
                    Save invoices {destinationConnection.requirement.collects}, using {sessionLabelById(sessions, destinationConnection.sessionId) ?? 'this session'}.
                  </p>
                  <Button type="button" variant="ghost" size="sm" className="self-start" onClick={changeDestinationConnection}>
                    Change connection
                  </Button>
                </div>
              ) : destinationExistingRecord ? (
                <div className="flex flex-col gap-2 rounded-lg border p-4">
                  <p className="text-sm font-medium">Connected</p>
                  <p className="text-sm text-muted-foreground">Save invoices to {destinationExistingRecord.name}.</p>
                  <Button type="button" variant="ghost" size="sm" className="self-start" onClick={changeDestinationConnection}>
                    Change connection
                  </Button>
                </div>
              ) : (
                <>
                  {existingDestinations.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs font-medium text-muted-foreground">Already set up</p>
                      {existingDestinations.map((record) => (
                        <Button
                          key={record.id}
                          type="button"
                          variant="outline"
                          className="h-auto justify-start whitespace-normal text-left"
                          onClick={() => handleReuseExistingDestination(record)}
                        >
                          Save invoices to {record.name}.
                        </Button>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    {existingDestinations.length > 0 && <p className="text-xs font-medium text-muted-foreground">Configure a new destination</p>}
                    <ConnectButtonList
                      rows={destinationRows}
                      sentence={destinationSentence}
                      onFresh={(plugin, requirement) => setDestinationFreshTarget({ plugin, requirement })}
                      onReuse={handleDestinationReuse}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {step === 'configure' && sourceConnection && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wizard-source-name">Collection name</Label>
                <Input
                  id="wizard-source-name"
                  value={sourceName}
                  onChange={(e) => {
                    setSourceNameEdited(true);
                    setSourceName(e.target.value);
                  }}
                  placeholder={sourceConnection.plugin.manifest.name}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wizard-source-scope">Scope (optional)</Label>
                <Input id="wizard-source-scope" value={sourceScope} onChange={(e) => setSourceScope(e.target.value)} placeholder="e.g. Finance department" />
              </div>
              <WizardSteps
                pluginId={sourceConnection.plugin.manifest.id}
                steps={sourceConnection.plugin.wizard}
                values={sourceValues}
                sessionId={sourceConnection.sessionId}
                onChange={(n, v) => setSourceValues((prev) => ({ ...prev, [n]: v }))}
              />

              {destinationConnection && (
                <WizardSteps
                  pluginId={destinationConnection.plugin.manifest.id}
                  steps={destinationConnection.plugin.wizard}
                  values={destinationValues}
                  sessionId={destinationConnection.sessionId}
                  onChange={(n, v) => setDestinationValues((prev) => ({ ...prev, [n]: v }))}
                />
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </>
          )}
        </fieldset>

        <DialogFooter>
          {step === 'sourceConnect' && !sourceSubViewActive && (
            <>
              <Button type="button" variant="ghost" onClick={() => void handleClose()}>
                Cancel
              </Button>
              {sourceConnection && (
                <Button type="button" onClick={() => setStep('destinationConnect')}>
                  Next
                </Button>
              )}
            </>
          )}
          {step === 'destinationConnect' && !destinationSubViewActive && (
            <>
              <Button type="button" variant="ghost" onClick={() => setStep('sourceConnect')}>
                Back
              </Button>
              {(destinationConnection || destinationExistingRecord) && (
                <Button type="button" onClick={() => setStep('configure')}>
                  Next
                </Button>
              )}
            </>
          )}
          {step === 'configure' && (
            <>
              <Button type="button" variant="ghost" onClick={() => setStep('destinationConnect')}>
                Back
              </Button>
              <Button type="button" disabled={submitting || !canSubmit} onClick={() => void submit()}>
                {submitting ? 'Adding…' : 'Add'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
