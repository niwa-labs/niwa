/** The home page: what the loaded modules put on it, as tiles. */

import { Slot } from "@niwa-labs/cockpit-sdk";

export function Home() {
  return (
    <div data-slot="home" className="flex min-w-0 flex-col gap-4 p-4">
      <h1 className="sr-only">Home</h1>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Slot name="home.tile" empty={<p className="col-span-full text-sm text-muted-foreground">Nothing has been put on this page yet.</p>} />
      </div>
    </div>
  );
}
