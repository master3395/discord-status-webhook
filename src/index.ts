import process from "node:process";
import { REST } from "@discordjs/rest";
import { KeyvSqlite } from "@keyv/sqlite";
import type { APIEmbed, APIMessage } from "discord-api-types/v10";
import { Keyv, KeyvHooks } from "keyv";
import { DateTime } from "luxon";
import {
	API_BASE,
	EMBED_COLOR_BLACK,
	EMBED_COLOR_GREEN,
	EMBED_COLOR_ORANGE,
	EMBED_COLOR_RED,
	EMBED_COLOR_YELLOW,
} from "./constants.js";
import type {
	StatusPageIncident,
	StatusPageResult,
} from "./interfaces/StatusPage.js";
import { logger } from "./logger.js";

const incidentData: Keyv = new Keyv<DataEntry>(
	new KeyvSqlite("sqlite:///data/data.sqlite"),
);

incidentData.hooks.addHandler(KeyvHooks.POST_GET, (data) => {
	if (data.value === undefined) {
		logger.debug(`Cache miss for key: ${data.key}`);
	} else {
		logger.debug(`Cache hit for key: ${data.key}`, data.value);
	}
});

interface DataEntry {
	messageID: string;
	incidentID: string;
	lastUpdate: string;
	resolved: boolean;
}

const rest = new REST({ version: "10" });

if (!process.env.DISCORD_WEBHOOK_ID || !process.env.DISCORD_WEBHOOK_TOKEN) {
	logger.error(`Missing required environment variable`);
	process.exit(1);
}

const hookBase = `webhooks/${process.env.DISCORD_WEBHOOK_ID}/${process.env.DISCORD_WEBHOOK_TOKEN}`;

function embedFromIncident(incident: StatusPageIncident) {
	const color =
		incident.status === "resolved" || incident.status === "postmortem"
			? EMBED_COLOR_GREEN
			: incident.impact === "critical"
				? EMBED_COLOR_RED
				: incident.impact === "major"
					? EMBED_COLOR_ORANGE
					: incident.impact === "minor"
						? EMBED_COLOR_YELLOW
						: EMBED_COLOR_BLACK;

	const affectedNames = incident.components.map((c) => c.name);

	const embed: APIEmbed = {
		color: Number.parseInt(color.slice(1), 16),
		timestamp: new Date(incident.started_at).toISOString(),
		url: incident.shortlink,
		title: incident.name,
		footer: {
			text: incident.id,
		},
	};

	for (const update of incident.incident_updates.reverse()) {
		const updateDT = DateTime.fromISO(update.created_at);
		const timeString = `<t:${Math.floor(updateDT.toSeconds())}:R>`;

		const currentFields = embed.fields ?? [];
		currentFields.push({
			name: `${update.status.charAt(0).toUpperCase()}${update.status.slice(1)} (${timeString})`,
			value: update.body,
		});

		embed.fields = currentFields;
	}

	const descriptionParts = [`• Impact: ${incident.impact}`];

	if (affectedNames.length) {
		descriptionParts.push(`• Affected Components: ${affectedNames.join(", ")}`);
	}

	embed.description = descriptionParts.join("\n");

	return embed;
}

function isResolvedStatus(status: string) {
	return ["resolved", "postmortem"].some((stat) => stat === status);
}

async function updateIncident(
	incident: StatusPageIncident,
	messageID?: string,
) {
	const embed = embedFromIncident(incident);

	try {
		const options = {
			auth: false,
			body: { embeds: [embed] },
		};

		const message = (await (messageID
			? rest.patch(`/${hookBase}/messages/${messageID}`, options)
			: rest.post(`/${hookBase}?wait=true`, options))) as APIMessage;

		logger.debug(`setting: ${incident.id} to message: ${message.id}`);

		await incidentData.set(incident.id, {
			incidentID: incident.id,
			lastUpdate: DateTime.now().toISO(),
			messageID: message.id,
			resolved: isResolvedStatus(incident.status),
		});
	} catch (_error) {
		const error = _error as Error;
		if (messageID) {
			logger.error(
				error,
				`error during hook update on incident ${incident.id} message: ${messageID}`,
			);
			return;
		}
		logger.error(error, `error during hook sending on incident ${incident.id}`);
	}
}

async function check() {
	logger.info("heartbeat");
	try {
		const json = (await fetch(`${API_BASE}/incidents.json`).then((r) =>
			r.json(),
		)) as StatusPageResult;
		const { incidents } = json;

		for (const incident of incidents.reverse()) {
			const data = await incidentData.get(incident.id);
			if (!data) {
				if (isResolvedStatus(incident.status)) {
					continue;
				}

				logger.info(`new incident: ${incident.id}`);
				void updateIncident(incident);
				continue;
			}

			const incidentUpdate = DateTime.fromISO(
				incident.updated_at ?? incident.created_at,
			);

			if (DateTime.fromISO(data.lastUpdate) < incidentUpdate) {
				logger.info(`update incident: ${incident.id}`);
				void updateIncident(incident, data.messageID);
			}
		}
	} catch (error) {
		logger.error(`error during fetch and update routine:\n`, error);
	}
}

void check();
setInterval(() => void check(), 60_000 * 5);
