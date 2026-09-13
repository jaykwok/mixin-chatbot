// 统计明细、检查详情、执行输出和确认框共用同一套滚动规则。
export class Viewport {
  private top = 0;
  private total = 0;
  private room = 1;
  constructor(private follow = false) {}
  reset(follow = false): void { this.top = 0; this.follow = follow; }
  slice(lines: string[], room: number): string[] {
    this.total = lines.length;
    this.room = Math.max(1, room);
    this.top = this.follow ? this.max : Math.min(this.top, this.max);
    return lines.slice(this.top, this.top + this.room);
  }
  private get max(): number { return Math.max(0, this.total - this.room); }
  onKey(key: string): boolean {
    switch (key) {
      case "up": case "k": this.top--; break;
      case "down": case "j": this.top++; break;
      case "pageup": this.top -= Math.max(1, this.room - 1); break;
      case "pagedown": this.top += Math.max(1, this.room - 1); break;
      case "home": this.top = 0; break;
      case "end": this.top = this.max; break;
      default: return false;
    }
    this.follow = key === "end";
    this.top = Math.max(0, Math.min(this.top, this.max));
    return true;
  }
  get label(): string {
    return this.total > this.room ? `${this.top + 1}–${Math.min(this.top + this.room, this.total)} / ${this.total}` : "";
  }
}
