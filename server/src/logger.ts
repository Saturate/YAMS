import {
	ansiColorFormatter,
	configure,
	getConsoleSink,
	jsonLinesFormatter,
} from "@logtape/logtape";

export async function initLogging(): Promise<void> {
	const isDev = process.env.NODE_ENV !== "production";

	await configure({
		sinks: {
			console: getConsoleSink({
				formatter: isDev ? ansiColorFormatter : jsonLinesFormatter,
			}),
		},
		loggers: [{ category: ["yams"], sinks: ["console"], lowestLevel: "info" }],
	});
}
