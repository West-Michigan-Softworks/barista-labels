# Publishing and printing labels

Admins sign in to Editor. Select the label tab and choose **Publish label**. Unsaved edits are saved first; a server revision conflict must be resolved before publishing. The status in the title bar shows the published version and whether there are draft changes. **Republish label** replaces the version offered to users; **Unpublish label** removes it from their catalog. Saving alone does not republish. Existing saved projects start unpublished.

Admins can switch to Printer to verify their published label. Switching back preserves their editor draft. A normal `Labels.User` account only sees Printer. Printer configuration is available only to admins.

In Printer:

1. Choose a published label.
2. For variable labels, download its CSV template, populate the required columns, and upload it. The download contains headers only. Do not add a quantity column. Completely empty rows are ignored; every accepted row produces one label, and partial rows are rejected.
3. Choose a location, then a printer at that location. Locations are currently displayed by number from `printersZPL.location`; printers without a location appear under **Unassigned location**.
4. Choose **Prepare preview**. All rows must compile successfully. Browse the prepared labels using Previous/Next and review any warnings.
5. Choose **Print**. The status and job list show the resulting batch. Repeated submission of the same prepared request does not duplicate it. To intentionally print again, use the explicit **Reprint** action and acknowledge that the original might have printed.

Static labels do not require CSV and allow quantity 1–10,000. Variable labels accept up to 5,000 nonempty rows and never allow a quantity override. CSV files can be at most 16 MB and each field can contain at most 10,000 characters. Values such as item numbers with leading zeros stay strings.

If an admin republishes or withdraws a label, refresh the catalog and prepare again before starting another print. Printer configuration changes also require preparation again. Jobs already queued retain their compiled labels. “Sent” means the bytes were transmitted, not that physical printing was confirmed. Cancel is available only while a job is queued.
