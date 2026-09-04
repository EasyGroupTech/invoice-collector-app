import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { InstalledPluginSummary as PluginSummary } from '../../../electron/shared/ipcContracts';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { runJobAndWait } from '../jobs';

type WizardStep = 'select' | 'connect' | 'configure';

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

function compatibleSessionsFor(plugin: PluginSummary, sessions: Session[]): Session[] {
  const requirement = plugin.sessionRequirements[0];
  if (!requirement) return [];
  return sessions.filter((s) => s.sessionTypeId === requirement.sessionTypeId && (requirement.confirmsBuiltIn || s.createdByPluginId === plugin.manifest.id));
}

const LOCAL_FOLDER_DESTINATION_PLUGIN_ID = 'app.easygroup.destination.local-folder';

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

interface SessionCreatePanelProps {
  plugin: PluginSummary;
  onCreated: (session: Session) => void;
}

/** Step 3's "establish it" half of what step 2 chose "create new" for — the plugin's own
 * permissions note/required-scopes instructions, plus whatever input the session type itself
 * needs to actually create one (today's built-ins gather that interactively — a device-code
 * prompt, a native folder picker — rather than a typed field, but this is the generic slot for a
 * session type that does need one, per the SDK's own `BuiltInSessionInputProvider` gap). */
function SessionCreatePanel({ plugin, onCreated }: SessionCreatePanelProps) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Session | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const requirement = plugin.sessionRequirements[0];

  if (!requirement) return null;

  async function createSession() {
    setCreating(true);
    setError(undefined);
    try {
      const session = await runJobAndWait<Session>(
        window.api.sessionsCreate({ pluginId: plugin.manifest.id, sessionTypeId: requirement.sessionTypeId }),
      );
      setCreated(session);
      onCreated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <p className="text-sm font-medium">Connect: {plugin.manifest.name}</p>
      {requirement.permissionsNote && <p className="text-sm text-muted-foreground">{requirement.permissionsNote}</p>}
      <p className="text-sm text-muted-foreground">Requires: {requirement.requiredScopesOrRoles.join(', ') || 'no specific scopes declared'}</p>
      {created ? (
        <p className="text-sm text-muted-foreground">Connected as “{created.label}”.</p>
      ) : (
        <div>
          <Button type="button" variant="outline" size="sm" disabled={creating} onClick={() => void createSession()}>
            {creating ? 'Creating…' : 'Create new session'}
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
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
 * for adding just one thing at a time). Three steps:
 * 1. **Select** — the source plugin and a destination (reuse an existing one, or configure a new
 *    one, defaulting to reusing one if any already exist — else to the local-folder destination,
 *    matching §14.1 US7's "zero-setup" framing).
 * 2. **Connect (choice only)** — for whichever of source/destination needs a session, pick "reuse
 *    an existing compatible one" or "create new", as a dropdown.
 * 3. **Connect (establish) + configure** — for anything step 2 said "create new" for, the actual
 *    instructions/input to establish it; then each plugin's own name + config fields; then submit.
 */
export function AddCollectorWizard({ onClose, onCreated }: AddCollectorWizardProps) {
  const [step, setStep] = useState<WizardStep>('select');
  const [sourcePlugins, setSourcePlugins] = useState<PluginSummary[]>([]);
  const [destinationPlugins, setDestinationPlugins] = useState<PluginSummary[]>([]);
  const [existingDestinations, setExistingDestinations] = useState<PluginBackedRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);

  const [sourcePluginId, setSourcePluginId] = useState<string | undefined>(undefined);
  const [destinationChoiceValue, setDestinationChoiceValue] = useState<string | undefined>(undefined);
  const [sourceSessionChoiceValue, setSourceSessionChoiceValue] = useState<string | undefined>(undefined);
  const [destinationSessionChoiceValue, setDestinationSessionChoiceValue] = useState<string | undefined>(undefined);
  const [sourceCreatedSession, setSourceCreatedSession] = useState<Session | undefined>(undefined);
  const [destinationCreatedSession, setDestinationCreatedSession] = useState<Session | undefined>(undefined);
  const [sourceName, setSourceName] = useState('');
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

  const sourceRequirement = sourcePlugin?.sessionRequirements[0];
  const destinationRequirement = destinationChoice?.kind === 'new' ? destinationChoice.plugin.sessionRequirements[0] : undefined;

  const sourceCompatibleSessions = sourcePlugin ? compatibleSessionsFor(sourcePlugin, sessions) : [];
  const destinationCompatibleSessions = destinationChoice?.kind === 'new' ? compatibleSessionsFor(destinationChoice.plugin, sessions) : [];

  // Default each session picker once its own data is ready: reuse the first compatible existing
  // session if one exists, else "create new" — same reuse-first reasoning as the destination
  // default above.
  useEffect(() => {
    if (!sourceRequirement || sourceSessionChoiceValue !== undefined) return;
    setSourceSessionChoiceValue(sourceCompatibleSessions.length > 0 ? `existing:${sourceCompatibleSessions[0].id}` : 'new');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceRequirement, sourceCompatibleSessions.length]);

  useEffect(() => {
    if (!destinationRequirement || destinationSessionChoiceValue !== undefined) return;
    setDestinationSessionChoiceValue(destinationCompatibleSessions.length > 0 ? `existing:${destinationCompatibleSessions[0].id}` : 'new');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationRequirement, destinationCompatibleSessions.length]);

  const sourceSessionChoice = decodeSessionChoice(sourceSessionChoiceValue);
  const destinationSessionChoice = decodeSessionChoice(destinationSessionChoiceValue);

  const resolvedSourceSessionId = sourceSessionChoice?.kind === 'existing' ? sourceSessionChoice.sessionId : sourceCreatedSession?.id;
  const resolvedDestinationSessionId =
    destinationSessionChoice?.kind === 'existing' ? destinationSessionChoice.sessionId : destinationCreatedSession?.id;

  const canProceedFromSelect = sourcePlugin !== undefined && destinationChoice !== undefined;
  const canProceedFromConnect = (!sourceRequirement || sourceSessionChoice !== undefined) && (!destinationRequirement || destinationSessionChoice !== undefined);
  const canSubmit = (!sourceRequirement || resolvedSourceSessionId !== undefined) && (!destinationRequirement || resolvedDestinationSessionId !== undefined);

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
      });
      toast.success(`${sourceName || sourcePlugin.manifest.name} added`);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const stepNumber = step === 'select' ? 1 : step === 'connect' ? 2 : 3;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a collector (step {stepNumber} of 3)</DialogTitle>
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

          {step === 'connect' && (
            <>
              {sourcePlugin && sourceRequirement && (
                <SessionModeSelect
                  id="wizard-source-session"
                  label={`Source connection (${sourceRequirement.sessionTypeId})`}
                  compatibleSessions={sourceCompatibleSessions}
                  value={sourceSessionChoiceValue}
                  onChange={setSourceSessionChoiceValue}
                />
              )}
              {destinationChoice?.kind === 'new' && destinationRequirement && (
                <SessionModeSelect
                  id="wizard-destination-session"
                  label={`Destination connection (${destinationRequirement.sessionTypeId})`}
                  compatibleSessions={destinationCompatibleSessions}
                  value={destinationSessionChoiceValue}
                  onChange={setDestinationSessionChoiceValue}
                />
              )}
              {!sourceRequirement && !(destinationChoice?.kind === 'new' && destinationRequirement) && (
                <p className="text-sm text-muted-foreground">Nothing needs connecting for this source/destination.</p>
              )}
            </>
          )}

          {step === 'configure' && sourcePlugin && (
            <>
              {sourcePlugin && sourceSessionChoice?.kind === 'new' && (
                <SessionCreatePanel plugin={sourcePlugin} onCreated={setSourceCreatedSession} />
              )}
              {destinationChoice?.kind === 'new' && destinationSessionChoice?.kind === 'new' && (
                <SessionCreatePanel plugin={destinationChoice.plugin} onCreated={setDestinationCreatedSession} />
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wizard-source-name">Source name</Label>
                <Input
                  id="wizard-source-name"
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  placeholder={sourcePlugin.manifest.name}
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
              <Button type="button" disabled={!canProceedFromSelect} onClick={() => setStep('connect')}>
                Next
              </Button>
            </>
          )}
          {step === 'connect' && (
            <>
              <Button type="button" variant="ghost" onClick={() => setStep('select')}>
                Back
              </Button>
              <Button type="button" disabled={!canProceedFromConnect} onClick={() => setStep('configure')}>
                Next
              </Button>
            </>
          )}
          {step === 'configure' && (
            <>
              <Button type="button" variant="ghost" onClick={() => setStep('connect')}>
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
