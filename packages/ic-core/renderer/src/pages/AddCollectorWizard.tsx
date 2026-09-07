import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DeviceCodeSignInPrompt } from '@/components/DeviceCodeSignInPrompt';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { InstalledPluginSummary as PluginSummary, SessionRequirement } from '../../../electron/shared/ipcContracts';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { useJob } from '../hooks/useJob';

type WizardStep = 'select' | 'chooseConnections' | 'establishConnections' | 'configure';

type DestinationChoice = { kind: 'existing'; record: PluginBackedRecord } | { kind: 'new'; plugin: PluginSummary };

/** Encodes a destination <Select>'s value as `existing:<recordId>` or `new:<pluginId>` — a plain
 * string is all Radix `Select` items support, and this is the cheapest way to carry "which of the
 * two option groups, and which specific one" through it without a parallel id-lookup elsewhere. */
function encodeDestinationChoice(choice: DestinationChoice): string {
  return choice.kind === 'existing' ? `existing:${choice.record.id}` : `new:${choice.plugin.manifest.id}`;
}

function decodeDestinationChoice(
  value: string | undefined,
  existingDestinations: PluginBackedRecord[],
  destinationPlugins: PluginSummary[],
): DestinationChoice | undefined {
  if (!value) return undefined;
  if (value.startsWith('existing:')) {
    const record = existingDestinations.find((d) => d.id === value.slice('existing:'.length));
    return record && { kind: 'existing', record };
  }
  const plugin = destinationPlugins.find((p) => p.manifest.id === value.slice('new:'.length));
  return plugin && { kind: 'new', plugin };
}

type SessionChoice = { kind: 'existing'; sessionId: string } | { kind: 'new' };

function decodeSessionChoice(value: string | undefined): SessionChoice | undefined {
  if (!value) return undefined;
  if (value === 'new') return { kind: 'new' };
  return { kind: 'existing', sessionId: value.slice('existing:'.length) };
}

/** Compatible sessions for one *specific* requirement of a plugin, not just its first one — a
 * plugin can declare more than one `sessionRequirements` entry (e.g. Graph Mail's own device-code
 * today, with client-credentials as a documented future addition), and which one the user picked
 * on the "choose connections" step decides which existing sessions even apply here. */
function compatibleSessionsFor(plugin: PluginSummary, sessions: Session[], sessionTypeId: string | undefined): Session[] {
  if (!sessionTypeId) return [];
  const requirement = plugin.sessionRequirements.find((r) => r.sessionTypeId === sessionTypeId);
  if (!requirement) return [];
  return sessions.filter((s) => s.sessionTypeId === requirement.sessionTypeId && (requirement.confirmsBuiltIn || s.createdByPluginId === plugin.manifest.id));
}

const LOCAL_FOLDER_DESTINATION_PLUGIN_ID = 'app.easygroup.destination.local-folder';

interface SessionTypeSelectProps {
  id: string;
  label: string;
  requirements: SessionRequirement[];
  value: string | undefined;
  onChange: (value: string) => void;
}

/** A plugin can declare more than one session type it can connect with — shown as its own
 * dropdown even when a plugin (like Graph Mail today) only declares one, so adding a second later
 * (client-credentials, say) doesn't require redesigning this step, just adding another
 * `SessionRequirement` to the plugin's manifest. */
function SessionTypeSelect({ id, label, requirements, value, onChange }: SessionTypeSelectProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {requirements.map((r) => (
            <SelectItem key={r.sessionTypeId} value={r.sessionTypeId}>
              {r.sessionTypeId}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface SessionModeSelectProps {
  id: string;
  label: string;
  compatibleSessions: Session[];
  value: string | undefined;
  onChange: (value: string) => void;
}

/** Step 2's own connection picker — "reuse one of these" or "create new", as one dropdown rather
 * than a radio list + a separate button, matching the same existing-vs-new pattern the "Collect
 * to" destination picker (step 1) already uses. Which one it resolves to only decides what step 3
 * shows next (a `SessionCreatePanel`, or nothing) — nothing is actually established here. */
function SessionModeSelect({ id, label, compatibleSessions, value, onChange }: SessionModeSelectProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {compatibleSessions.length > 0 && (
            <SelectGroup>
              <SelectLabel>Existing sessions</SelectLabel>
              {compatibleSessions.map((s) => (
                <SelectItem key={s.id} value={`existing:${s.id}`}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          <SelectGroup>
            <SelectLabel>Create new</SelectLabel>
            <SelectItem value="new">Create a new session</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

export interface EstablishedSession {
  session: Session;
  name: string;
}

interface SessionCreatePanelProps {
  plugin: PluginSummary;
  requirement: SessionRequirement;
  value: EstablishedSession | undefined;
  onChange: (value: EstablishedSession | undefined) => void;
}

/** Step 3's "establish it" half of what step 2 chose "create new" for. Once the session job
 * finishes, asks the plugin (via `SessionLabelSuggester`, e.g. Graph Mail deriving the signed-in
 * tenant's domain) for a friendly name, then hands the user an editable field pre-filled with that
 * suggestion — the actual rename only lands (via `sessionsRename`) when the wizard advances past
 * this step, so an edit here never fights the suggestion fetch. */
function SessionCreatePanel({ plugin, requirement, value, onChange }: SessionCreatePanelProps) {
  const job = useJob<Session>();
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    if (!job.result?.ok || value) return;
    const session = job.result.result;
    setSuggesting(true);
    void window.api
      .sessionsSuggestLabel({ pluginId: plugin.manifest.id, sessionId: session.id })
      .then((suggested) => onChange({ session, name: suggested ?? session.label }))
      .finally(() => setSuggesting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.result]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <p className="text-sm font-medium">Connect: {plugin.manifest.name}</p>
      {requirement.permissionsNote && <p className="text-sm text-muted-foreground">{requirement.permissionsNote}</p>}
      <p className="text-sm text-muted-foreground">Requires: {requirement.requiredScopesOrRoles.join(', ') || 'no specific scopes declared'}</p>

      {!value && !job.jobId && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void job.start(window.api.sessionsCreate({ pluginId: plugin.manifest.id, sessionTypeId: requirement.sessionTypeId }))}
          >
            Sign in
          </Button>
        </div>
      )}

      {job.jobId && !job.result && <DeviceCodeSignInPrompt progressLog={job.progressLog} />}

      {job.result && !job.result.ok && <p className="text-sm text-destructive">{job.result.error}</p>}

      {value && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`session-name-${plugin.manifest.id}`}>Session name</Label>
          <Input
            id={`session-name-${plugin.manifest.id}`}
            value={value.name}
            disabled={suggesting}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
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
 * §14.1 US4/US7's guided "add a collector" flow — a source paired with where it collects to, in
 * one dialog, replacing the plain kind-scoped `AddRecordDialog` for the Collect page's own
 * top-level Add button (Settings' own Sources/Destinations sections keep using the simpler dialog
 * for adding just one thing at a time). Four steps:
 * 1. **Select** — the source plugin and a destination (reuse an existing one, or configure a new
 *    one, defaulting to reusing one if any already exist — else to the local-folder destination,
 *    matching §14.1 US7's "zero-setup" framing).
 * 2. **Choose connections** — for whichever of source/destination needs a session, pick which
 *    session TYPE to use (a plugin can declare more than one — shown as its own dropdown even when
 *    only one exists today), then "reuse an existing compatible one" or "create new".
 * 3. **Establish connections** — for anything step 2 said "create new" for, the actual sign-in
 *    (a live device-code prompt for today's built-in session types) plus an editable friendly name
 *    for the resulting session, defaulting to whatever the plugin suggests once signed in.
 * 4. **Configure** — each plugin's own record name + wizard fields, then submit.
 */
export function AddCollectorWizard({ onClose, onCreated }: AddCollectorWizardProps) {
  const [step, setStep] = useState<WizardStep>('select');
  const [sourcePlugins, setSourcePlugins] = useState<PluginSummary[]>([]);
  const [destinationPlugins, setDestinationPlugins] = useState<PluginSummary[]>([]);
  const [existingDestinations, setExistingDestinations] = useState<PluginBackedRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);

  const [sourcePluginId, setSourcePluginId] = useState<string | undefined>(undefined);
  const [destinationChoiceValue, setDestinationChoiceValue] = useState<string | undefined>(undefined);
  const [sourceSessionTypeId, setSourceSessionTypeId] = useState<string | undefined>(undefined);
  const [destinationSessionTypeId, setDestinationSessionTypeId] = useState<string | undefined>(undefined);
  const [sourceSessionChoiceValue, setSourceSessionChoiceValue] = useState<string | undefined>(undefined);
  const [destinationSessionChoiceValue, setDestinationSessionChoiceValue] = useState<string | undefined>(undefined);
  const [sourceEstablished, setSourceEstablished] = useState<EstablishedSession | undefined>(undefined);
  const [destinationEstablished, setDestinationEstablished] = useState<EstablishedSession | undefined>(undefined);
  const [sourceName, setSourceName] = useState('');
  const [sourceScope, setSourceScope] = useState('');
  const [destinationName, setDestinationName] = useState('');
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

  // Default "Collect to" once its data has loaded: reuse the first existing destination if one is
  // already set up (avoids silently piling up duplicate destinations every time), otherwise
  // configure a new one — preferring the local-folder plugin specifically, matching §14.1 US7's
  // "zero-setup local Downloads folder destination" framing, else whichever destination plugin is
  // actually installed.
  useEffect(() => {
    if (destinationChoiceValue !== undefined) return;
    if (existingDestinations.length > 0) {
      setDestinationChoiceValue(encodeDestinationChoice({ kind: 'existing', record: existingDestinations[0] }));
    } else if (destinationPlugins.length > 0) {
      const localFolder = destinationPlugins.find((p) => p.manifest.id === LOCAL_FOLDER_DESTINATION_PLUGIN_ID);
      setDestinationChoiceValue(encodeDestinationChoice({ kind: 'new', plugin: localFolder ?? destinationPlugins[0] }));
    }
  }, [existingDestinations, destinationPlugins, destinationChoiceValue]);

  const sourcePlugin = sourcePlugins.find((p) => p.manifest.id === sourcePluginId);
  const destinationChoice = decodeDestinationChoice(destinationChoiceValue, existingDestinations, destinationPlugins);

  // Default each session-TYPE picker once its plugin is known, and re-default if the current
  // selection stops being one of the plugin's declared types (e.g. the user picked a different
  // source plugin after already picking a type for the previous one).
  useEffect(() => {
    if (!sourcePlugin) {
      if (sourceSessionTypeId !== undefined) setSourceSessionTypeId(undefined);
      return;
    }
    if (sourceSessionTypeId && sourcePlugin.sessionRequirements.some((r) => r.sessionTypeId === sourceSessionTypeId)) return;
    setSourceSessionTypeId(sourcePlugin.sessionRequirements[0]?.sessionTypeId);
  }, [sourcePlugin, sourceSessionTypeId]);

  useEffect(() => {
    if (destinationChoice?.kind !== 'new') {
      if (destinationSessionTypeId !== undefined) setDestinationSessionTypeId(undefined);
      return;
    }
    const plugin = destinationChoice.plugin;
    if (destinationSessionTypeId && plugin.sessionRequirements.some((r) => r.sessionTypeId === destinationSessionTypeId)) return;
    setDestinationSessionTypeId(plugin.sessionRequirements[0]?.sessionTypeId);
  }, [destinationChoice, destinationSessionTypeId]);

  const sourceRequirement = sourcePlugin?.sessionRequirements.find((r) => r.sessionTypeId === sourceSessionTypeId);
  const destinationRequirement =
    destinationChoice?.kind === 'new' ? destinationChoice.plugin.sessionRequirements.find((r) => r.sessionTypeId === destinationSessionTypeId) : undefined;

  const sourceCompatibleSessions = sourcePlugin ? compatibleSessionsFor(sourcePlugin, sessions, sourceSessionTypeId) : [];
  const destinationCompatibleSessions =
    destinationChoice?.kind === 'new' ? compatibleSessionsFor(destinationChoice.plugin, sessions, destinationSessionTypeId) : [];

  // Whenever the selected session TYPE changes (including a plugin swap), the previous
  // existing-vs-new choice no longer necessarily applies — clear it so the default-selection
  // effect below re-derives it for the newly selected type.
  useEffect(() => {
    setSourceSessionChoiceValue(undefined);
    setSourceEstablished(undefined);
  }, [sourceSessionTypeId]);

  useEffect(() => {
    setDestinationSessionChoiceValue(undefined);
    setDestinationEstablished(undefined);
  }, [destinationSessionTypeId]);

  // Default each session picker once its own data is ready: reuse the first compatible existing
  // session if one exists, else "create new" — same reuse-first reasoning as the destination
  // default above.
  useEffect(() => {
    if (!sourceRequirement || sourceSessionChoiceValue !== undefined) return;
    setSourceSessionChoiceValue(sourceCompatibleSessions.length > 0 ? `existing:${sourceCompatibleSessions[0].id}` : 'new');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceRequirement, sourceCompatibleSessions.length, sourceSessionChoiceValue]);

  useEffect(() => {
    if (!destinationRequirement || destinationSessionChoiceValue !== undefined) return;
    setDestinationSessionChoiceValue(destinationCompatibleSessions.length > 0 ? `existing:${destinationCompatibleSessions[0].id}` : 'new');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationRequirement, destinationCompatibleSessions.length, destinationSessionChoiceValue]);

  const sourceSessionChoice = decodeSessionChoice(sourceSessionChoiceValue);
  const destinationSessionChoice = decodeSessionChoice(destinationSessionChoiceValue);

  const resolvedSourceSessionId = sourceSessionChoice?.kind === 'existing' ? sourceSessionChoice.sessionId : sourceEstablished?.session.id;
  const resolvedDestinationSessionId =
    destinationSessionChoice?.kind === 'existing' ? destinationSessionChoice.sessionId : destinationEstablished?.session.id;

  const canProceedFromSelect = sourcePlugin !== undefined && destinationChoice !== undefined;
  const canProceedFromChooseConnections =
    (!sourceRequirement || sourceSessionChoice !== undefined) && (!destinationRequirement || destinationSessionChoice !== undefined);
  const canProceedFromEstablish =
    (!sourceRequirement || sourceSessionChoice?.kind === 'existing' || sourceEstablished !== undefined) &&
    (!destinationRequirement || destinationSessionChoice?.kind === 'existing' || destinationEstablished !== undefined);
  const canSubmit = (!sourceRequirement || resolvedSourceSessionId !== undefined) && (!destinationRequirement || resolvedDestinationSessionId !== undefined);

  async function proceedToConfigure() {
    setError(undefined);
    try {
      if (sourcePlugin && sourceEstablished && sourceEstablished.name !== sourceEstablished.session.label) {
        await window.api.sessionsRename({ pluginId: sourcePlugin.manifest.id, sessionId: sourceEstablished.session.id, label: sourceEstablished.name });
      }
      if (destinationChoice?.kind === 'new' && destinationEstablished && destinationEstablished.name !== destinationEstablished.session.label) {
        await window.api.sessionsRename({
          pluginId: destinationChoice.plugin.manifest.id,
          sessionId: destinationEstablished.session.id,
          label: destinationEstablished.name,
        });
      }
      setStep('configure');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit() {
    if (!sourcePlugin || !destinationChoice || !canSubmit) return;

    const sourceValidation = validateWizardValues(sourcePlugin.wizard, sourceValues);
    if (!sourceValidation.valid) {
      setError(`Missing required source field(s): ${sourceValidation.missingFields.join(', ')}`);
      return;
    }
    if (destinationChoice.kind === 'new') {
      const destinationValidation = validateWizardValues(destinationChoice.plugin.wizard, destinationValues);
      if (!destinationValidation.valid) {
        setError(`Missing required destination field(s): ${destinationValidation.missingFields.join(', ')}`);
        return;
      }
    }

    setSubmitting(true);
    setError(undefined);
    try {
      const destinationId =
        destinationChoice.kind === 'existing'
          ? destinationChoice.record.id
          : (
              await window.api.configCreateRecord({
                kind: 'destination',
                pluginId: destinationChoice.plugin.manifest.id,
                pluginVersion: destinationChoice.plugin.manifest.version,
                name: destinationName || destinationChoice.plugin.manifest.name,
                config: destinationValues,
                sessionId: resolvedDestinationSessionId,
              })
            ).id;

      await window.api.configCreateRecord({
        kind: 'source',
        pluginId: sourcePlugin.manifest.id,
        pluginVersion: sourcePlugin.manifest.version,
        name: sourceName || sourcePlugin.manifest.name,
        config: sourceValues,
        destinationId,
        sessionId: resolvedSourceSessionId,
        scope: sourceScope || undefined,
      });
      toast.success(`${sourceName || sourcePlugin.manifest.name} added`);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const stepNumber = step === 'select' ? 1 : step === 'chooseConnections' ? 2 : step === 'establishConnections' ? 3 : 4;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a collector (step {stepNumber} of 4)</DialogTitle>
        </DialogHeader>

        <fieldset disabled={submitting} className="flex flex-col gap-4">
          {step === 'select' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wizard-source-plugin">Configure source</Label>
                <Select value={sourcePluginId} onValueChange={setSourcePluginId}>
                  <SelectTrigger id="wizard-source-plugin" className="w-full">
                    <SelectValue placeholder="Select a source…" />
                  </SelectTrigger>
                  <SelectContent>
                    {sourcePlugins.map((p) => (
                      <SelectItem key={p.manifest.id} value={p.manifest.id}>
                        {p.manifest.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wizard-destination">Collect to</Label>
                <Select value={destinationChoiceValue} onValueChange={setDestinationChoiceValue}>
                  <SelectTrigger id="wizard-destination" className="w-full">
                    <SelectValue placeholder="Select a destination…" />
                  </SelectTrigger>
                  <SelectContent>
                    {existingDestinations.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Existing destinations</SelectLabel>
                        {existingDestinations.map((d) => (
                          <SelectItem key={d.id} value={encodeDestinationChoice({ kind: 'existing', record: d })}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {destinationPlugins.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Configure new</SelectLabel>
                        {destinationPlugins.map((p) => (
                          <SelectItem key={p.manifest.id} value={encodeDestinationChoice({ kind: 'new', plugin: p })}>
                            {p.manifest.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {step === 'chooseConnections' && (
            <>
              {sourcePlugin && sourcePlugin.sessionRequirements.length > 0 && (
                <div className="flex flex-col gap-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">{sourcePlugin.manifest.name} connection</p>
                  <SessionTypeSelect
                    id="wizard-source-session-type"
                    label="Connection type"
                    requirements={sourcePlugin.sessionRequirements}
                    value={sourceSessionTypeId}
                    onChange={setSourceSessionTypeId}
                  />
                  {sourceRequirement && (
                    <SessionModeSelect
                      id="wizard-source-session"
                      label="Use"
                      compatibleSessions={sourceCompatibleSessions}
                      value={sourceSessionChoiceValue}
                      onChange={setSourceSessionChoiceValue}
                    />
                  )}
                </div>
              )}
              {destinationChoice?.kind === 'new' && destinationChoice.plugin.sessionRequirements.length > 0 && (
                <div className="flex flex-col gap-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">{destinationChoice.plugin.manifest.name} connection</p>
                  <SessionTypeSelect
                    id="wizard-destination-session-type"
                    label="Connection type"
                    requirements={destinationChoice.plugin.sessionRequirements}
                    value={destinationSessionTypeId}
                    onChange={setDestinationSessionTypeId}
                  />
                  {destinationRequirement && (
                    <SessionModeSelect
                      id="wizard-destination-session"
                      label="Use"
                      compatibleSessions={destinationCompatibleSessions}
                      value={destinationSessionChoiceValue}
                      onChange={setDestinationSessionChoiceValue}
                    />
                  )}
                </div>
              )}
              {!(sourcePlugin && sourcePlugin.sessionRequirements.length > 0) &&
                !(destinationChoice?.kind === 'new' && destinationChoice.plugin.sessionRequirements.length > 0) && (
                  <p className="text-sm text-muted-foreground">Nothing needs connecting for this source/destination.</p>
                )}
            </>
          )}

          {step === 'establishConnections' && (
            <>
              {sourcePlugin && sourceRequirement && sourceSessionChoice?.kind === 'new' && (
                <SessionCreatePanel plugin={sourcePlugin} requirement={sourceRequirement} value={sourceEstablished} onChange={setSourceEstablished} />
              )}
              {destinationChoice?.kind === 'new' && destinationRequirement && destinationSessionChoice?.kind === 'new' && (
                <SessionCreatePanel
                  plugin={destinationChoice.plugin}
                  requirement={destinationRequirement}
                  value={destinationEstablished}
                  onChange={setDestinationEstablished}
                />
              )}
              {sourceSessionChoice?.kind !== 'new' && destinationSessionChoice?.kind !== 'new' && (
                <p className="text-sm text-muted-foreground">Reusing existing connections — nothing new to sign in to.</p>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </>
          )}

          {step === 'configure' && sourcePlugin && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wizard-source-name">Source name</Label>
                <Input
                  id="wizard-source-name"
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  placeholder={sourcePlugin.manifest.name}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wizard-source-scope">Scope (optional)</Label>
                <Input
                  id="wizard-source-scope"
                  value={sourceScope}
                  onChange={(e) => setSourceScope(e.target.value)}
                  placeholder="e.g. Finance department"
                />
              </div>
              <WizardSteps
                pluginId={sourcePlugin.manifest.id}
                steps={sourcePlugin.wizard}
                values={sourceValues}
                sessionId={resolvedSourceSessionId}
                onChange={(n, v) => setSourceValues((prev) => ({ ...prev, [n]: v }))}
              />

              {destinationChoice?.kind === 'new' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="wizard-destination-name">Destination name</Label>
                    <Input
                      id="wizard-destination-name"
                      value={destinationName}
                      onChange={(e) => setDestinationName(e.target.value)}
                      placeholder={destinationChoice.plugin.manifest.name}
                    />
                  </div>
                  <WizardSteps
                    pluginId={destinationChoice.plugin.manifest.id}
                    steps={destinationChoice.plugin.wizard}
                    values={destinationValues}
                    sessionId={resolvedDestinationSessionId}
                    onChange={(n, v) => setDestinationValues((prev) => ({ ...prev, [n]: v }))}
                  />
                </>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </>
          )}
        </fieldset>

        <DialogFooter>
          {step === 'select' && (
            <>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" disabled={!canProceedFromSelect} onClick={() => setStep('chooseConnections')}>
                Next
              </Button>
            </>
          )}
          {step === 'chooseConnections' && (
            <>
              <Button type="button" variant="ghost" onClick={() => setStep('select')}>
                Back
              </Button>
              <Button type="button" disabled={!canProceedFromChooseConnections} onClick={() => setStep('establishConnections')}>
                Next
              </Button>
            </>
          )}
          {step === 'establishConnections' && (
            <>
              <Button type="button" variant="ghost" onClick={() => setStep('chooseConnections')}>
                Back
              </Button>
              <Button type="button" disabled={!canProceedFromEstablish} onClick={() => void proceedToConfigure()}>
                Next
              </Button>
            </>
          )}
          {step === 'configure' && (
            <>
              <Button type="button" variant="ghost" onClick={() => setStep('establishConnections')}>
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
