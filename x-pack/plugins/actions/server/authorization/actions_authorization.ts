/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import Boom from '@hapi/boom';
import { KibanaRequest } from '@kbn/core/server';
import { SecurityPluginSetup } from '@kbn/security-plugin/server';
import {
  ACTION_SAVED_OBJECT_TYPE,
  ACTION_TASK_PARAMS_SAVED_OBJECT_TYPE,
} from '../constants/saved_objects';
import { isBidirectionalConnectorType } from '../lib/bidirectional_connectors';
import { AuthorizationMode } from './get_authorization_mode_by_source';

export interface ConstructorOptions {
  request: KibanaRequest;
  authorization?: SecurityPluginSetup['authz'];
  // In order to support legacy Alerts which predate the introduction of the
  // Actions feature in Kibana we need a way of "dialing down" the level of
  // authorization for certain opearations.
  // Specifically, we want to allow these old alerts and their scheduled
  // actions to continue to execute - which requires that we exempt auth on
  // `get` for Connectors and `execute` for Action execution when used by
  // these legacy alerts
  authorizationMode?: AuthorizationMode;
}

const operationAlias: Record<string, (authorization: SecurityPluginSetup['authz']) => string[]> = {
  execute: (authorization) => [
    authorization.actions.savedObject.get(ACTION_SAVED_OBJECT_TYPE, 'get'),
    authorization.actions.savedObject.get(ACTION_TASK_PARAMS_SAVED_OBJECT_TYPE, 'create'),
  ],
  list: (authorization) => [
    authorization.actions.savedObject.get(ACTION_SAVED_OBJECT_TYPE, 'find'),
  ],
};

const LEGACY_RBAC_EXEMPT_OPERATIONS = new Set(['get', 'execute']);

export class ActionsAuthorization {
  private readonly request: KibanaRequest;
  private readonly authorization?: SecurityPluginSetup['authz'];
  private readonly authorizationMode: AuthorizationMode;

  constructor({
    request,
    authorization,
    authorizationMode = AuthorizationMode.RBAC,
  }: ConstructorOptions) {
    this.request = request;
    this.authorization = authorization;
    this.authorizationMode = authorizationMode;
  }

  public async ensureAuthorized({
    operation,
    actionTypeId,
    additionalPrivileges = [],
  }: {
    operation: string;
    actionTypeId?: string;
    additionalPrivileges?: string[];
  }) {
    const { authorization } = this;
    if (authorization?.mode?.useRbacForRequest(this.request)) {
      if (!this.isOperationExemptDueToLegacyRbac(operation)) {
        const checkPrivileges = authorization.checkPrivilegesDynamicallyWithRequest(this.request);

        const privileges = operationAlias[operation]
          ? operationAlias[operation](authorization)
          : [authorization.actions.savedObject.get(ACTION_SAVED_OBJECT_TYPE, operation)];

        const { hasAllRequested } = await checkPrivileges({
          kibana: [
            ...privileges,
            ...additionalPrivileges,
            // SentinelOne and Crowdstrike sub-actions require that a user have `all` privilege to Actions and Connectors.
            // This is a temporary solution until a more robust RBAC approach can be implemented for sub-actions
            isBidirectionalConnectorType(actionTypeId)
              ? 'api:actions:execute-advanced-connectors'
              : 'api:actions:execute-basic-connectors',
          ],
        });
        if (!hasAllRequested) {
          throw Boom.forbidden(
            `Unauthorized to ${operation} ${
              actionTypeId ? `a "${actionTypeId}" action` : `actions`
            }`
          );
        }
      }
    }
  }

  private isOperationExemptDueToLegacyRbac(operation: string) {
    return (
      this.authorizationMode === AuthorizationMode.Legacy &&
      LEGACY_RBAC_EXEMPT_OPERATIONS.has(operation)
    );
  }
}
