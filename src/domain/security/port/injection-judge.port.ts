export interface InjectionJudgeOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

export interface InjectionJudgePort {
  judge(query: string, options?: InjectionJudgeOptions): Promise<boolean>;
}
