# 查看附件

下载指定邮件的附件。

```http
GET /api/mails/:id/attachments/:attachmentId
X-Admin-Key: your-admin-key
```

## 路径参数

| 参数 | 说明 |
| --- | --- |
| `id` | 邮件 ID，对应邮件列表返回的 `data[].id` |
| `attachmentId` | 附件 ID，对应 `GET /api/mails?includeAttachments=true` 返回的 `data[].attachments[].id` |

## 成功响应

附件下载成功时直接返回文件流，不返回 JSON。

| Header | 说明 |
| --- | --- |
| `Content-Type` | 附件 MIME 类型，缺省为 `application/octet-stream` |
| `Content-Disposition` | 浏览器下载文件名 |

## 失败响应

```json
{
  "ok": false,
  "error": {
    "code": "attachment_not_found",
    "message": "附件不存在或未保存内容"
  }
}
```

| 状态码 | code | 说明 |
| --- | --- | --- |
| `404` | `attachment_storage_disabled` | 未启用 R2 附件保存 |
| `404` | `attachment_not_found` | 附件不存在、未保存，或 R2 对象缺失 |
