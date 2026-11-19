import attachments from "./attachments";
import form from "./form";
import integrations from "./integrations";
import meta from "./meta";
import people from "./people";
import requests from "./requests";
import tickets from "./tickets";
import updates from "./updates";

/** Routers mounted under /api/v1. */
export const API_MODULES = [meta, form, requests, tickets, attachments, people, integrations, updates];
