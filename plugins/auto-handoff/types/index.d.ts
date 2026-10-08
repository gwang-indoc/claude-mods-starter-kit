export type AutoHandoffSaved = { path: string; at: number; reason: string; startedAt?: number; percent?: number };
export type AutoHandoffVerdict = { percent: number; text: string };
export type AutoHandoffOffer = { at: number; file: string };
export type AutoHandoffSwitch = { at: number; percent: number };

declare module "claude-code" {
  interface PluginState {
    "auto-handoff": {
      cwd: string;
      isInteractive: boolean;
      fired: boolean;
      busy: boolean;
      last: AutoHandoffSaved | null;
      offer: AutoHandoffOffer | null;
      isTurnRunning: boolean;
      isEditOpen: boolean;
      isTodoActive: boolean;
      activeTasks: string[];
      isChecking: boolean;
      lastCheck: number | null;
      switched: AutoHandoffSwitch | null;
      isCarried: boolean;
      prepared: { path: string } | null;
      latestStart: number;
      compactedAt: number;
      lastVerdict: AutoHandoffVerdict | null;
      signalAge: number;
      checksUsed: number;
    };
  }
}
