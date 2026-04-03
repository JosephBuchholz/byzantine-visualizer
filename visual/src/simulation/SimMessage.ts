export const CLIENT_ID = "client";

export default class SimMessage {
  content: string;
  fromID: string;
  toID: string;

  constructor(content: string, fromID: string, toID: string) {
    this.content = content;
    this.fromID = fromID;
    this.toID = toID;
  }
}
