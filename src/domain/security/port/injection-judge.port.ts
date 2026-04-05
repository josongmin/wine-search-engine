export interface InjectionJudgePort {
  judge(query: string): Promise<boolean>;
}
