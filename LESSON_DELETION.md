# Lesson deletion

An admin can delete a draft or published lesson with `DELETE /api/lessons/:id`.
The admin lesson editor exposes this action in its top bar with a confirmation.

Deletion runs under the same lesson lock as authoring and publication. It archives
the lesson and its active texts/workspaces, revokes every publication, and clears
the current publication. Admin lists, detail URLs, analytics, learner lists,
pinned publications and their audio authorization no longer expose the lesson.
Attempts to edit, publish, or generate audio for a deleted lesson return 404.
The API returns 204 on success, 401/403 for unauthorized requests, 404 for a
missing/deleted lesson, and 409 while any of its texts has queued or running audio.

This is a retained deletion: immutable releases, word states, progress, shared
vocabulary recordings, usages and files remain in storage. Other lessons can
continue reusing those recordings. There is no admin restore or permanent purge
action in this change.

Apply the additive `20261019090000_lesson_deletion` migration before deploying
the backend, then deploy the admin UI. No mobile update is required.
