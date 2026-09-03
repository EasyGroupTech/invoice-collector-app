import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PROFILE_ID = 'default';

export interface ProfileMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

interface ProfilesFile {
  version: 1;
  activeProfileId: string;
  profiles: ProfileMeta[];
}

export interface ProfileManager {
  init(): Promise<void>;
  list(): Promise<ProfileSummary[]>;
  switchActive(profileId: string): Promise<void>;
  create(name: string, copyFromCurrent: boolean): Promise<ProfileSummary>;
  remove(profileId: string): Promise<void>;
  /**
   * Synchronous by design: the profile directory is on the hot path of ~every config/history
   * read in the app, and making this async would force every one of those call sites to become
   * async too. Kept in sync with `activeProfileId` by every mutating method below.
   */
  getActiveProfileDir(): string;
}

/**
 * Unlike the original Electron app's `profiles.ts` (module-level singleton state, appropriate
 * for a literal main-process singleton), this returns an independent instance per `baseDir` —
 * makes ic-core usable as a library and unit-testable against real temp directories without
 * tests stomping on each other's global state.
 */
export function createProfileManager(baseDir: string): ProfileManager {
  let activeProfileId = DEFAULT_PROFILE_ID;
  let cachedState: ProfilesFile | null = null;

  function profilesFilePath(): string {
    return path.join(baseDir, 'profiles.json');
  }

  function profileDir(profileId: string): string {
    return path.join(baseDir, 'profiles', profileId);
  }

  async function fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async function readProfilesFile(): Promise<ProfilesFile> {
    return JSON.parse(await readFile(profilesFilePath(), 'utf-8')) as ProfilesFile;
  }

  async function saveProfilesFile(state: ProfilesFile): Promise<void> {
    await mkdir(baseDir, { recursive: true });
    await writeFile(profilesFilePath(), JSON.stringify(state, null, 2), 'utf-8');
    cachedState = state;
  }

  async function currentState(): Promise<ProfilesFile> {
    if (!cachedState) {
      cachedState = await readProfilesFile();
    }
    return cachedState;
  }

  return {
    getActiveProfileDir: () => profileDir(activeProfileId),

    async init() {
      if (await fileExists(profilesFilePath())) {
        const state = await readProfilesFile();
        cachedState = state;
        activeProfileId = state.activeProfileId;
        return;
      }

      await mkdir(profileDir(DEFAULT_PROFILE_ID), { recursive: true });
      const now = new Date().toISOString();
      const state: ProfilesFile = {
        version: 1,
        activeProfileId: DEFAULT_PROFILE_ID,
        profiles: [{ id: DEFAULT_PROFILE_ID, name: 'Default', createdAt: now, updatedAt: now }],
      };
      await saveProfilesFile(state);
      activeProfileId = DEFAULT_PROFILE_ID;
    },

    async list() {
      const state = await currentState();
      return state.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        isActive: p.id === state.activeProfileId,
        createdAt: p.createdAt,
      }));
    },

    async switchActive(profileId) {
      const state = await currentState();
      if (!state.profiles.some((p) => p.id === profileId)) {
        throw new Error(`Profile not found: ${profileId}`);
      }
      await saveProfilesFile({ ...state, activeProfileId: profileId });
      activeProfileId = profileId;
    },

    async create(name, copyFromCurrent) {
      const state = await currentState();
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Profile name is required.');
      }

      const baseSlug = slugify(trimmedName);
      let id = baseSlug;
      let suffix = 2;
      while (state.profiles.some((p) => p.id === id)) {
        id = `${baseSlug}-${suffix}`;
        suffix += 1;
      }

      const dir = profileDir(id);
      await mkdir(dir, { recursive: true });

      if (copyFromCurrent) {
        const sourceConfigPath = path.join(profileDir(activeProfileId), 'config.json');
        if (await fileExists(sourceConfigPath)) {
          // Deliberately never copies invoice-history.json — a new profile starts with a clean
          // dedup history even when it's seeded from an existing profile's sources/destinations.
          await cp(sourceConfigPath, path.join(dir, 'config.json'));
        }
      }

      const now = new Date().toISOString();
      const meta: ProfileMeta = { id, name: trimmedName, createdAt: now, updatedAt: now };
      await saveProfilesFile({ ...state, profiles: [...state.profiles, meta] });

      return { id, name: meta.name, isActive: id === activeProfileId, createdAt: now };
    },

    async remove(profileId) {
      const state = await currentState();
      if (profileId === activeProfileId) {
        throw new Error('Switch to a different profile before deleting this one.');
      }
      const remaining = state.profiles.filter((p) => p.id !== profileId);
      if (remaining.length === state.profiles.length) {
        throw new Error(`Profile not found: ${profileId}`);
      }
      if (remaining.length === 0) {
        throw new Error('At least one profile must exist.');
      }

      await saveProfilesFile({ ...state, profiles: remaining });
      await rm(profileDir(profileId), { recursive: true, force: true });
    },
  };
}

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'profile';
}
