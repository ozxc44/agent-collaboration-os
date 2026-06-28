import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-license-test-secret';

const LICENSE_CONTENT: Record<string, string> = {
  mit: `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
`,
  apache: `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
`,
  gpl: `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

Copyright (C) 2007 Free Software Foundation, Inc.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
`,
  bsd2: `BSD 2-Clause License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.
`,
  bsd3: `BSD 3-Clause License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software.
`,
  mpl: `Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor" means each individual or legal entity that creates, contributes
to the creation of, or owns Covered Software.
`,
};

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const owner = await register(baseUrl, 'owner');
    const other = await register(baseUrl, 'other');

    // ─── Absent license ───────────────────────────────────────────────────────
    const noLicenseProject = await createProject(baseUrl, owner.token, 'No License');
    await seedFile(baseUrl, owner.token, noLicenseProject, 'README.md', '# No License');
    await seedFile(baseUrl, owner.token, noLicenseProject, 'src/main.ts', 'console.log(1);');
    const noLicenseSummary = await getSummary(baseUrl, owner.token, noLicenseProject);
    assert.equal(noLicenseSummary.data.license, null, 'license should be null when absent');

    // ─── MIT root license ─────────────────────────────────────────────────────
    const mitProject = await createProject(baseUrl, owner.token, 'MIT Project');
    await seedFile(baseUrl, owner.token, mitProject, 'LICENSE', LICENSE_CONTENT.mit);
    const mitSummary = await getSummary(baseUrl, owner.token, mitProject);
    assert.ok(mitSummary.data.license, 'MIT license should be detected');
    assert.equal(mitSummary.data.license.key, 'mit');
    assert.equal(mitSummary.data.license.name, 'MIT License');
    assert.equal(mitSummary.data.license.path, 'LICENSE');

    // ─── Apache-2.0 root license (with .md extension) ─────────────────────────
    const apacheProject = await createProject(baseUrl, owner.token, 'Apache Project');
    await seedFile(baseUrl, owner.token, apacheProject, 'LICENSE.md', LICENSE_CONTENT.apache);
    const apacheSummary = await getSummary(baseUrl, owner.token, apacheProject);
    assert.ok(apacheSummary.data.license, 'Apache license should be detected');
    assert.equal(apacheSummary.data.license.key, 'apache-2.0');
    assert.equal(apacheSummary.data.license.name, 'Apache License 2.0');
    assert.equal(apacheSummary.data.license.path, 'LICENSE.md');

    // ─── GPL-3.0 copyleft root license (COPYING.txt) ──────────────────────────
    const gplProject = await createProject(baseUrl, owner.token, 'GPL Project');
    await seedFile(baseUrl, owner.token, gplProject, 'COPYING.txt', LICENSE_CONTENT.gpl);
    const gplSummary = await getSummary(baseUrl, owner.token, gplProject);
    assert.ok(gplSummary.data.license, 'GPL license should be detected');
    assert.equal(gplSummary.data.license.key, 'gpl-3.0');
    assert.equal(gplSummary.data.license.name, 'GNU General Public License v3.0');
    assert.equal(gplSummary.data.license.path, 'COPYING.txt');

    // ─── BSD-2-Clause explicit license ────────────────────────────────────────
    const bsd2Project = await createProject(baseUrl, owner.token, 'BSD-2 Project');
    await seedFile(baseUrl, owner.token, bsd2Project, 'LICENSE', LICENSE_CONTENT.bsd2);
    const bsd2Summary = await getSummary(baseUrl, owner.token, bsd2Project);
    assert.ok(bsd2Summary.data.license, 'BSD-2 license should be detected');
    assert.equal(bsd2Summary.data.license.key, 'bsd-2-clause');

    // ─── BSD-3-Clause explicit license ────────────────────────────────────────
    const bsd3Project = await createProject(baseUrl, owner.token, 'BSD-3 Project');
    await seedFile(baseUrl, owner.token, bsd3Project, 'LICENSE', LICENSE_CONTENT.bsd3);
    const bsd3Summary = await getSummary(baseUrl, owner.token, bsd3Project);
    assert.ok(bsd3Summary.data.license, 'BSD-3 license should be detected');
    assert.equal(bsd3Summary.data.license.key, 'bsd-3-clause');

    // ─── MPL-2.0 root license ─────────────────────────────────────────────────
    const mplProject = await createProject(baseUrl, owner.token, 'MPL Project');
    await seedFile(baseUrl, owner.token, mplProject, 'LICENSE', LICENSE_CONTENT.mpl);
    const mplSummary = await getSummary(baseUrl, owner.token, mplProject);
    assert.ok(mplSummary.data.license, 'MPL license should be detected');
    assert.equal(mplSummary.data.license.key, 'mpl-2.0');

    // ─── Non-root license file is ignored ─────────────────────────────────────
    const nestedProject = await createProject(baseUrl, owner.token, 'Nested License');
    await seedFile(baseUrl, owner.token, nestedProject, 'vendor/LICENSE', LICENSE_CONTENT.mit);
    const nestedSummary = await getSummary(baseUrl, owner.token, nestedProject);
    assert.equal(nestedSummary.data.license, null, 'nested license file should be ignored');

    // ─── Case-insensitive root license file name ──────────────────────────────
    const caseProject = await createProject(baseUrl, owner.token, 'Case License');
    await seedFile(baseUrl, owner.token, caseProject, 'license.md', LICENSE_CONTENT.mit);
    const caseSummary = await getSummary(baseUrl, owner.token, caseProject);
    assert.ok(caseSummary.data.license, 'case-insensitive license file should be detected');
    assert.equal(caseSummary.data.license.key, 'mit');
    assert.equal(caseSummary.data.license.path, 'license.md');

    // ─── Project scoping: license must not leak across projects ───────────────
    const scopedBase = await createProject(baseUrl, owner.token, 'Scoped Base');
    await seedFile(baseUrl, owner.token, scopedBase, 'README.md', '# Scoped');

    const scopedOther = await createProject(baseUrl, other.token, 'Scoped Other');
    await seedFile(baseUrl, other.token, scopedOther, 'LICENSE', LICENSE_CONTENT.mit);

    const baseSummary = await getSummary(baseUrl, owner.token, scopedBase);
    assert.equal(baseSummary.data.license, null, 'base project should not inherit other license');

    const otherSummary = await getSummary(baseUrl, other.token, scopedOther);
    assert.equal(otherSummary.data.license.key, 'mit');

    console.log('project-license tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectLicenseTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function createProject(baseUrl: string, token: string, name: string): Promise<string> {
  const response = await api(baseUrl, 'POST', '/v1/projects', token, {
    name,
    visibility: 'private',
  });
  assert.equal(response.status, 201, `create project ${name}`);
  return response.data.id;
}

async function seedFile(
  baseUrl: string,
  token: string,
  projectId: string,
  path: string,
  content: string,
): Promise<void> {
  const response = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, token, {
    path,
    content,
  });
  assert.equal(response.status, 201, `seed ${path}`);
}

async function getSummary(
  baseUrl: string,
  token: string,
  projectId: string,
): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/summary`, token);
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
