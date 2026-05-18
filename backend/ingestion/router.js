import { ingestPDF } from "./pdf_ingest.js";
import { ingestEmail } from "./email_ingest.js";
import { ingestFOIA } from "./foia_ingest.js";
import { ingestFax } from "./fax_ingest.js";
import { ingestJailLog } from "./jail_log_ingest.js";
import { ingestTransport } from "./transport_ingest.js";

export async function ingest(type, payload) {
  switch (type) {
    case "pdf":       return ingestPDF(payload);
    case "email":     return ingestEmail(payload);
    case "foia":      return ingestFOIA(payload);
    case "fax":       return ingestFax(payload);
    case "jail_log":  return ingestJailLog(payload);
    case "transport": return ingestTransport(payload);
    default:
      throw new Error(`Unknown ingestion type: ${type}`);
  }
}
