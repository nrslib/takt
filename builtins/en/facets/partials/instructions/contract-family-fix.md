**Contract family role: `fix`**

{{include:instructions/contract-family-core}}

For every accepted family, reconstruct its complete graph before editing and classify `participates / preserved / outside`. Even when a finding cites one location, repair the common owner and every `participates` path while retaining `preserved` behavior.

After editing, search again for reconstruction under another name, direct literals, obsolete helpers, unmigrated consumers, and one-sided updates, and remove every remaining instance.
