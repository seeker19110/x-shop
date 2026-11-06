/** Log injection (CWE-117): thay CR/LF và mọi ký tự điều khiển (C0, DEL, C1) bằng dấu cách trước khi ghi log. */
// eslint-disable-next-line no-control-regex -- chủ đích khớp ký tự điều khiển
export const oneLine = (v) => String(v).replace(/[\r\n\u0000-\u001f\u007f-\u009f]/g, " ");
