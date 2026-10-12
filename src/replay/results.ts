// A business_outcome is a valid answer ("no such member"), not an error. Waiting on a person is a run state, not a result.

export type ReplayResult =
  | { status: "success"; outputs: Record<string, string | number>; stepsExecuted: number }
  | { status: "business_outcome"; code: string; description: string; stepsExecuted: number }
  | {
      status: "failure";
      stepIndex: number;
      stepDescription: string;
      expected: string;
      observed: string;
      errorCode: string;
      message: string;
    }
  | { status: "rehearsal_complete"; stoppedBeforeStep: number; stepsExecuted: number; confirmTargetStrategy: number };
