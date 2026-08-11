import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type DashboardTab = "upcoming" | "active" | "history" | "paused-ended" | "settings";

const TABS: ReadonlyArray<{ value: DashboardTab; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "active", label: "Active" },
  { value: "history", label: "Payment history" },
  { value: "paused-ended", label: "Paused & ended" },
  { value: "settings", label: "Settings" },
];

export interface DashboardNavProps {
  value: DashboardTab;
  onChange: (tab: DashboardTab) => void;
}

/** PLAN.md §16.1's five-item consumer nav. `Tabs` (base-ui, keyboard-navigable, visible focus per CLAUDE.md §13) rather than a router — a single dashboard page, no per-tab data reload needed. */
export function DashboardNav({ value, onChange }: DashboardNavProps) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as DashboardTab)} data-testid="dashboard-nav">
      <TabsList className="w-full sm:w-fit">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} data-testid={`dashboard-tab-${tab.value}`}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
