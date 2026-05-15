# 查看邮件列表

```http
GET /api/mails?limit=20&toDomain=example.com
X-Admin-Key: your-admin-key
```

## 查询参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | number | 否 | 每页数量，默认 `20`，范围 `1-50` |
| `cursor` | string | 否 | 下一页游标，使用上次返回的 `pagination.nextCursor` |
| `from` | string | 否 | 按发件邮箱精确筛选 |
| `to` | string | 否 | 按收件邮箱精确筛选 |
| `toDomain` | string | 否 | 按收件域名精确筛选 |
| `subject` | string | 否 | 按主题全文检索 |
| `content` | string | 否 | 按正文全文检索 |
| `hasAttachments` | boolean | 否 | 是否只看带附件邮件，仅支持 `true` 或 `false` |
| `includeAttachments` | boolean | 否 | 是否返回附件元信息，默认不返回；需要下载附件时设为 `true` |

## 默认返回示例

```json
{
  "ok": true,
  "data": [
    {
      "id": "mail_abc123",
      "messageId": "<message-id@example.com>",
      "from": "sender@example.com",
      "fromName": "Sender",
      "to": "user@example.com",
      "toDomain": "example.com",
      "forwarded": false,
      "subject": "Invoice May",
      "preview": "Your invoice is ready",
      "text": "Your invoice is ready.",
      "html": "<p>Your invoice is ready.</p>",
      "hasAttachments": true,
      "attachmentCount": 1,
      "size": 188000,
      "receivedAt": "2026-05-06T10:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "nextCursor": "eyJyZWNlaXZlZEF0IjoiMjAyNi0wNS0wNlQxMDowMDowMC4wMDBaIiwiaWQiOiJtYWlsX2FiYzEyMyJ9",
    "hasMore": true
  }
}
```

带 `includeAttachments=true` 时，邮件对象会额外返回 `attachments`：

```json
{
  "id": "mail_abc123",
  "hasAttachments": true,
  "attachmentCount": 1,
  "attachments": [
    {
      "id": "att_abc123",
      "filename": "invoice.pdf",
      "mimeType": "application/pdf",
      "size": 102400,
      "contentId": "",
      "disposition": "attachment",
      "stored": true
    }
  ]
}
```

## 邮件字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 邮件 ID，用于创建共享链接和下载附件 |
| `messageId` | string | 原始邮件 `Message-ID` |
| `from` | string | 发件邮箱 |
| `fromName` | string | 发件人显示名 |
| `to` | string | 收件邮箱 |
| `toDomain` | string | 收件域名 |
| `forwarded` | boolean | 是否来自转发邮件识别 |
| `subject` | string | 主题 |
| `preview` | string | 正文摘要 |
| `text` | string | 纯文本正文 |
| `html` | string | HTML 正文 |
| `attachments` | array | 附件元信息，仅 `includeAttachments=true` 时返回 |
| `hasAttachments` | boolean | 是否有附件 |
| `attachmentCount` | number | 附件数量 |
| `size` | number | 原始邮件大小，单位字节 |
| `receivedAt` | string | 接收时间，ISO 8601 |

## 附件字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 附件 ID |
| `filename` | string | 文件名 |
| `mimeType` | string | 文件 MIME 类型 |
| `size` | number | 文件大小，单位字节 |
| `contentId` | string | 内联附件 Content-ID，没有则为空 |
| `disposition` | string | `attachment` 或 `inline` |
| `stored` | boolean | 是否已保存到 R2；只有 `true` 才能下载 |

公开接口没有单封邮件详情接口，列表接口已经返回正文。附件元信息默认不返回，需要下载附件时使用 `includeAttachments=true` 获取附件 ID。
