const Error = require('@cardstack/plugin-utils/error');
const qs = require('qs');
const { merge } = require('lodash');
const koaJSONBody = require('koa-json-body');
const log = require('@cardstack/logger')('cardstack/jsonapi');
const { declareInjections } = require('@cardstack/di');
const { URL } = require('url');
const { withJsonErrorHandling } = Error;
const asyncBusboy = require('async-busboy');
const mimeMatch = require("mime-match");

module.exports = declareInjections({
  searcher: 'hub:searchers',
  writers: 'hub:writers',
  indexers: 'hub:indexers',
  controllingBranch: 'hub:controlling-branch',
}, {
  create({ searcher, writers, indexers, controllingBranch }) {
    return {
      category: 'api',
      after: 'authentication',
      middleware() {
        return jsonapiMiddleware(searcher, writers, indexers, controllingBranch.name);
      }
    };
  }
});

function jsonapiMiddleware(searcher, writers, indexers, defaultBranch) {
  // TODO move into config
  let options = {
    defaultBranch,
    servedPrefixes: 'api-validate|api'
  };

  let prefixPattern;
  if (options.servedPrefixes) {
    prefixPattern = new RegExp(`^/(${options.servedPrefixes})/?(.*)`);
  }
  let body = koaJSONBody({ limit: '16mb' });

  return async (ctxt, next) => {
    if (prefixPattern) {
      let m = prefixPattern.exec(ctxt.request.path);
      if (m) {
        options.prefix = m[1];
        ctxt.request.path = '/'+m[2];
      } else {
        return next();
      }
    }

    ctxt.response.set('Access-Control-Allow-Origin', '*');
    if (ctxt.request.method === 'OPTIONS') {
      ctxt.response.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      ctxt.response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, X-Requested-With');
      ctxt.status = 200;
      return;
    }

    let handler = new Handler(searcher, writers, indexers, ctxt, options);

    let contentType = ctxt.request.headers['content-type'];
    let isJsonApi = contentType && contentType.includes('application/vnd.api+json');
    let isMultipart = contentType && contentType.includes('multipart/form-data');

    let [acceptedTypes] = (ctxt.request.headers['accept'] || "").split(";");
    let types = acceptedTypes.split(",");
    let acceptsEverything = (types.length === 1 && types[0] === "*/*");
    let acceptsJsonApi = types.some(t => mimeMatch(t, "application/vnd.api+json"));
    let acceptsJson = types.some(t => mimeMatch(t, "application/json"));

    if (isMultipart || (acceptedTypes.length && !acceptsEverything && !acceptsJson && !isJsonApi && !acceptsJsonApi)) {
      return handler.runBinary();
    }


    // This is here in case an earlier middleware needs to parse the
    // body before us. That's OK as long as they also set this flag to
    // warn us.
    //
    // TODO: a better solution would be to split the body parsing step
    // out as a separate stage in our middleware stack, so that this
    // plugin (and others) can just list themselves as { after: 'body-parsing' }
    if (!ctxt.state.bodyAlreadyParsed) {
      await body(ctxt, err => {
        if (err) {
          throw err;
        }
      });
    }
    return handler.run();
  };
}

class Handler {
  constructor(searcher, writers, indexers, ctxt, options) {
    this.searcher = searcher;
    this.writers = writers;
    this.indexers = indexers;
    this.ctxt = ctxt;
    this.query = qs.parse(this.ctxt.request.querystring, { plainObjects: true });
    this.branch = this.query.branch || options.defaultBranch;
    this.prefix = options.prefix || '';
  }

  get session() {
    return this.ctxt.state.cardstackSession;
  }

  get isValidationRequest() {
    return this.prefix === 'api-validate';
  }

  filterExpression(type) {
    let filter = this.query.filter;
    if (!filter) {
      filter = {};
    }
    if (type != null) {
      // This overwrites any additional type filter the user tried to
      // provide in their query, which is reasonable (the endpoint
      // name itself is taking precedence).
      filter.type = {
        exact: type
      };
    }
    return filter;
  }

  async run() {
    this.ctxt.response.set('Content-Type', 'application/vnd.api+json');
    await withJsonErrorHandling(this.ctxt, async () => {
     let [methodName, segments] = this.getBaseMethodNameAndSegments();
      log.debug("attempting to match method %s", methodName);
      let method = this[methodName];
      if (method) {
        await method.apply(this, segments.slice(1).filter(Boolean));
      }
    });
  }

  async runBinary() {
    let [baseMethodName, segments] = this.getBaseMethodNameAndSegments();
    let methodName = `${baseMethodName}Binary`;

    log.debug("attempting to match method %s", methodName);
    let method = this[methodName];
    if (method) {
      await method.apply(this, segments.slice(1));
    }
  }

  getBaseMethodNameAndSegments() {
    let segments = this.ctxt.request.path.split('/').map(decodeURIComponent);
    let kind;

    //TODO: Just checking how many segments we have is not robust enough
    // PATCH /comments doesn't make sense, and
    // POST /comments/1 either
    if (segments.length < 3) {
      kind = 'Collection';
    } else {
      kind = 'Individual';
    }
    let methodName;
    if (this.isValidationRequest) {
      methodName = `handle${kind}Validate`;
    } else {
      methodName = `handle${kind}${this.ctxt.request.method}`;
    }

    return [methodName, segments];
  }

  async handleCollectionValidate(type) {
    let session = this.session;
    let data = this._mandatoryBodyData();
    let schema = await this.writers.schema.forBranch(this.branch);
    let { writer } = this.writers._getSchemaDetailsForType(schema, type);
    let isSchema = this.writers.schemaTypes.includes(type);
    let pendingChange = await writer.prepareCreate(
      this.branch,
      session,
      type,
      schema.withOnlyRealFields(data.data),
      isSchema
    );
    await schema.validate(pendingChange, { type, session });
    this.ctxt.status = 200;
  }

  async handleIndividualValidate(type, id) {
    let session = this.session;
    let data = this._mandatoryBodyData();
    let schema = await this.writers.schema.forBranch(this.branch);
    let { writer } = this.writers._getSchemaDetailsForType(schema, type);
    let isSchema = this.writers.schemaTypes.includes(type);
    let pendingChange = await writer.prepareUpdate(
      this.branch,
      session,
      type,
      id,
      schema.withOnlyRealFields(data.data),
      isSchema
    );
    await schema.validate(pendingChange, { type, id, session });
    // NOTE: We don't want validation to change the document in any way
    // this.ctxt.body = data;
    this.ctxt.status = 200;
  }

  async handleIndividualGET(type, id) {
    let include = (this.query.include || '').split(',');
    let body = await this.searcher.get(this.session, this.branch, type, id, include);
    if (this.query.include === '') {
      delete body.included;
    }
    this.ctxt.body = body;
  }

  async handleIndividualGETBinary(type, id) {
    let [buffer, json] = await this.searcher.getBinary(this.session, this.branch, type, id);
    this.ctxt.set('content-type', json.data.attributes['content-type']);
    this.ctxt.body = buffer;
  }

  async handleIndividualPATCH(type, id) {
    let data = this._mandatoryBodyData();
    let record = await this.writers.update(this.branch, this.session, type, id, data);
    this.ctxt.body = record;
    this.ctxt.status = 200;
  }

  async handleIndividualDELETE(type, id) {
    try {
      let version = this.ctxt.header['if-match'];
      await this.writers.delete(this.branch, this.session, version, type, id);
      this.ctxt.status = 204;
    } catch (err) {
      // By convention, the writer always refers to the version as
      // /data/meta/version, since that's where it would come from in
      // a PATCH or POST. But in a DELETE it comes from a header, so
      // we adjust any error message.
      if (err.source && err.source.pointer === '/data/meta/version') {
        err.source = { header: 'If-Match' };
      }
      throw err;
    }
  }

  async handleCollectionGET(type) {
    let { data: models, meta: { page }, included } = await this.searcher.search(this.session, this.branch, {
      filter: this.filterExpression(type),
      sort: this.query.sort,
      page: this.query.page,
      include: this.query.include,
      queryString: this.query.q
    });
    let body = { data: models, meta: { total: page.total } };
    if (page.cursor) {
      body.links = {
        next: this._urlWithUpdatedParams({ page: { cursor: page.cursor } })
      };
    }
    this.ctxt.body = body;
    if (this.query.include !== '' && included && included.length > 0) {
      body.included = included;
    }
  }

  async handleCollectionPOST(type) {
    let data = this._mandatoryBodyData();
    let record = await this.writers.create(this.branch, this.session, type, data);
    this.ctxt.body = record;
    this.ctxt.status = 201;
    let origin = this.ctxt.request.origin;
    if (this.prefix) {
      origin += '/' + this.prefix;
    }
    this.ctxt.set('location', origin + this.ctxt.request.path + '/' + record.data.id);
  }

  async handleCollectionPOSTBinary(type) {
    let { files } = await asyncBusboy(this.ctxt.req);

    if (!files[0]) {
      throw new Error("A file was not included in your post request. If you are not trying to upload a file, make sure to set your request content type to application/vnd.api+json", {status: 400});
    }

    let record = await this.writers.createBinary(this.branch, this.session, type, files[0]);
    this.ctxt.body = record;
    this.ctxt.status = 201;
    let origin = this.ctxt.request.origin;
    if (this.prefix) {
      origin += '/' + this.prefix;
    }
    this.ctxt.set('location', origin + this.ctxt.request.path + '/' + record.data.id);
  }


  _mandatoryBodyData() {
    let data;
    if (!this.ctxt.request.body || !(data = this.ctxt.request.body.data)) {
      throw new Error('A body with a top-level "data" property is required', {
        status: 400
      });
    }
    return { data };
  }

  _urlWithUpdatedParams(params) {
    let p = merge({}, this.query, params);
    let origin = this.ctxt.request.origin;
    if (this.prefix) {
      origin = origin + '/' + this.prefix;
    }
    let u = new URL(origin + (this.ctxt.req.originalUrl || this.ctxt.req.url));
    u.search = "?" + qs.stringify(p, { encode: false });
    return u.href;
  }
}
