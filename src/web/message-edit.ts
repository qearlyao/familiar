type EditableStep = {
	kind: string;
};

type EditableTextStep = EditableStep & {
	kind: "text";
	text: string;
	complete?: boolean;
};

export function applyMessageEditToSteps<Step extends EditableStep>(
	steps: readonly Step[],
	text: string,
	createTextStep: (index: number) => Step & EditableTextStep,
): Step[] {
	let replaced = false;
	const next: Step[] = [];
	for (const step of steps) {
		if (step.kind === "error") continue;
		if (step.kind !== "text") {
			next.push(step);
			continue;
		}
		if (replaced) continue;
		replaced = true;
		next.push({ ...step, text, complete: true } as Step);
	}
	if (!replaced) next.push(createTextStep(next.length));
	return next;
}
