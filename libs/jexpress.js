const restify = require("restify");
const path = require("path");
const security = require("../libs/security");
const datamunging = require("../libs/datamunging");
const login = require("../libs/login");
const groups = require("../libs/groups");
const setup = require("../libs/setup");
const querystring = require("querystring");
const fs = require("fs");
const morgan = require("morgan");
const Cache = require("../libs/cache");

var cache = new Cache();
var models = {};

// Middleware
const middlewareModel = (req, res, next) => {
	var modelname = req.params.modelname;
	req.modelname = modelname;
	// console.log("Model", modelname);
	try {
		req.Model = models[modelname];
		return next();
	} catch (err) {
		console.error(err);
		return res.send(404, "Model " + modelname + " not found");
	}
};

const middlewarePasswords = (req, res, next) => {
	if (req.body && req.body.password && !req.query.password_override) {
		req.body.password = security.encPassword(req.body.password);
		// console.log("Password encrypted");
	}
	next();
};

const middlewareCheckAdmin = (req, res, next) => {
	//We don't want users to pump up their own permissions
	if (req.modelname !== "user") return next();
	if (req.user.admin) return next();
	req.params.admin = false;
	next();
};

// Just log the most NB user fields
const filterLogUser = function(user) {
	if (user && user._id) {
		return {
			_id: user._id,
			email: user.email,
			name: user.name
		};
	}
	return null;
};

// Outputs whatever is in res.result as JSON
const outputJSON = (req, res, next) => {
	res.send(res.result);
}

// Outputs whatever is in res.result as CSV
const outputCSV = (req, res, next) => {
	const json2csv = require('json2csv').parse;
	const opts = { "flatten": true };
	if (!res.result.data) {
		res.send(500, "Not CSVable data");
	}
	res.writeHead(200, {
		'Content-Type': 'text/csv',
		'Content-Disposition': 'attachment; filename=export.csv'
	});
	try {
		const csv = json2csv(res.result.data[0]._doc, opts);
		res.end(csv);
	} catch (err) {
		console.error(err);
		res.send(500, err);
	}
}

// Actions (verbs)
const actionGet = (req, res, next) => {
	console.time("GET " + req.modelname);

	var parseSearch = function(search) {
		var result = {};
		for (var i in search) {
			result[i] = new RegExp(search[i], "i");
		}
		return result;
	};

	var filters = {};
	try {
		filters = parseFilter(req.query.filter);
	} catch (err) {
		console.trace(err);
		res.send(500, { status: "error", message: err.toString() });
		return;
	}
	var search = parseSearch(req.query.search);
	for (var i in search) {
		filters[i] = search[i];
	}
	var qcount = req.Model.find(filters);
	var q = req.Model.find(filters);
	var checkDeleted = [{ _deleted: false }, { _deleted: null }];
	if (!req.query.showDeleted) {
		qcount.or(checkDeleted);
		q.or(checkDeleted);
	}
	if (req.query.search) {
		// console.log({ search: req.query.search });
		q = req.Model.find({ $text: { $search: req.query.search }}, { score : { $meta: "textScore" } }).sort( { score: { $meta : "textScore" } } );
		qcount = req.Model.find({ $text: { $search: req.query.search }});
	}
	qcount.countDocuments({}, function(err, count) {
		if (err) {
			console.trace(err);
			res.send(500, { status: "error", message: err.toString() });
			return;
		}
		var result = {};
		result.count = count;
		var limit = parseInt(req.query.limit);
		if (limit) {
			q.limit(limit);
			result.limit = limit;
			var page_count = Math.ceil(count / limit);
			result.page_count = page_count;
			var page = parseInt(req.query.page);
			page = page ? page : 1;
			result.page = page;
			if (page < page_count) {
				result.next = changeUrlParams(req, "page", page + 1);
			}
			if (page > 1) {
				result.prev = changeUrlParams(req, "page", page - 1);
				q.skip(limit * (page - 1));
			}
		}
		if (req.query.sort) {
			q.sort(req.query.sort);
			result.sort = req.query.sort;
		}
		if (req.query.populate) {
			try {
				q.populate(req.query.populate);
				result.populate = req.query.populate;
			} catch (err) {
				console.trace(err);
				res.send(500, { status: "error", message: err.toString() });
				return;
			}
		}
		if (req.query.autopopulate) {
			for (let key in req.Model.schema.paths) {
				var dirpath = req.Model.schema.paths[key];
				if (dirpath.instance == "ObjectID" && dirpath.options.ref) {
					q.populate(dirpath.path);
				}
			}
			result.autopopulate = true;
		}
		if (req.query.fields) {
			var fields = req.query.fields.split(",");
			var select = {};
			fields.forEach(field => {
				select[field] = 1;
			});
			q.select(select);
		}
		if (req.query.search) {
			result.search = req.query.search;
		}
		try {
			q.exec(function(err, items) {
				if (err) {
					console.error(err);
					res.send(500, err);
				} else {
					// console.log({ action_id: 3, action: "Fetched documents", type: req.modelname, count: result.count, autopopulate: result.autopopulate, limit: result.limit, page: result.page, filters: filters, user: filterLogUser(req.user) });
					result.data = items;
					// res.send(result);
					res.result = result;
					console.timeEnd("GET " + req.modelname);
					next();
				}
			});
		} catch (err) {
			console.trace(err);
			res.send(500, { status: "error", message: err.toString() });
			return;
		}
	});
};

const actionGetOne = (req, res) => {
	console.time("GET " + req.modelname + "/" + req.params.item_id);
	getOne(req.Model, req.params.item_id, req.query).then(
		function(item) {
			res.send(item);
			console.timeEnd("GET " + req.modelname + "/" + req.params.item_id);
		},
		function(err) {
			console.trace(err);
			if (err.code) {
				res.send(500, { status: "error", message: err.msg });
			} else {
				res.send(500, { status: "error", message: err.toString() });
			}
		}
	);
};

const actionPost = (req, res, next) => {
	console.time("POST " + req.modelname);
	try {
		var item = new req.Model();
		_populateItem(item, datamunging.deserialize(req.body));
		if (req.user) {
			item._owner_id = req.user._id;
			item.__user = req.user;
		}
		item.save(function(err, result) {
			if (err) {
				console.trace(err);
				res.send(500, { status: "error", message: err.toString() });
				return;
			} else {
				// console.log({ action_id: 4, action: "Post", type: req.modelname, id: result._id, user: filterLogUser(req.user), params: req.params });
				var silence = req.params._silence;
				if (req.body && req.body._silence) silence = true;
				if (!silence)
					req.config.callbacks.post.call(
						null,
						req.modelname,
						result,
						req.user
					);
				res.json({
					status: "ok",
					message: req.modelname + " created",
					data: item
				});
				console.timeEnd("POST " + req.modelname);
				return;
			}
		});
	} catch (err) {
		console.trace(err);
		res.send(500, { status: "error", message: err.toString() });
		return;
	}
};

const actionPut = (req, res) => {
	console.time("PUT " + req.modelname + "/" + req.params.item_id);
	try {
		req.Model.findById(req.params.item_id, function(err, item) {
			if (err) {
				console.trace(err);
				res.send(500, { status: "error", message: err.toString() });
			} else {
				if (item) {
					_populateItem(item, datamunging.deserialize(req.body));
					_versionItem(item);
					try {
						if (req.user) {
							item.__user = req.user;
						}
						item.save(function(err, data) {
							if (err) {
								console.trace(err);
								res.send(500, {
									status: "error",
									message: err.toString()
								});
							} else {
								// console.log({ action_id: 5, action: "Put", type: req.modelname, id: item._id, user: filterLogUser(req.user), params: req.params });
								var silence = req.params._silence;
								if (req.body && req.body._silence) silence = true;
								if (!silence)
									req.config.callbacks.put.call(
										null,
										req.modelname,
										item,
										req.user
									);
								res.json({
									status: "ok",
									message: req.modelname + " updated",
									data: data
								});
								console.timeEnd(
									"PUT " +
										req.modelname +
										"/" +
										req.params.item_id
								);
							}
						});
					} catch (err) {
						console.trace(err);
						res.send(500, {
							status: "error",
							message: err.toString()
						});
						return;
					}
				} else {
					console.error("Document not found");
					res.send(404, "Document not found");
					return;
				}
			}
		});
	} catch (err) {
		console.trace(err);
		res.send(500, { status: "error", message: err.toString() });
		return;
	}
};

const actionDelete = (req, res) => {
	var silence = req.params._silence;
	if (req.body && req.body._silence) silence = true;
	req.Model.findById(req.params.item_id, function(err, item) {
		if (!item) {
			console.error("Couldn't find item for delete");
			res.send(404, "Could not find document");
			return;
		}
		if (err) {
			console.trace(err);
			res.send(500, { status: "error", message: err.toString() });
			return;
		}
		if (req.user) {
			item.__user = req.user;
		}
		if (req.Model.schema.paths.hasOwnProperty("_deleted")) {
			// console.log("Soft deleting");
			item._deleted = true;
			_versionItem(item);
			item.save(function(err) {
				if (err) {
					console.trace(err);
					res.send(500, { status: "error", message: err.toString() });
				} else {
					// console.log({ action_id: 6, action: "Delete", type: req.modelname, softDelete: true, id: item._id, user: filterLogUser(req.user), params: req.params });
					if (!silence)
						req.config.callbacks.delete.call(
							null,
							req.modelname,
							item,
							req.user,
							{ soft: true }
						);
					res.json({
						status: "ok",
						message: req.modelname + " deleted"
					});
				}
			});
		} else {
			// console.log("Hard deleting");
			item.deleteOne(function(err) {
				if (err) {
					console.trace(err);
					res.send(500, { status: "error", message: err.toString() });
				} else {
					// console.log({ action_id: 6, action: "Delete", type: req.modelname, softDelete: false, id: item._id, user: filterLogUser(req.user), params: req.params });
					if (!silence)
						req.config.callbacks.delete.call(
							null,
							req.modelname,
							item,
							req.user,
							{ soft: false }
						);
					res.json({
						status: "ok",
						message: req.modelname + " deleted"
					});
				}
			});
		}
	});
};

const actionCall = (req, res) => {
	// console.log({ action_id: 7, action: "Method called", type: req.modelname, method: req.params.method_name, user: filterLogUser(req.user) });
	req.body = req.body || {};
	req.body.__user = req.user || null;
	req.Model[req.params.method_name](req.body).then(
		function(result) {
			res.json(result);
		},
		function(err) {
			console.trace(err);
			res.send(500, { status: "error", message: err.toString() });
		}
	);
};

const actionCallItem = (req, res) => {
	req.Model.findById(req.params.item_id, function(err, item) {
		if (!item) {
			res.send(404, "Document not found for " + req.params.method_name);
			return;
		}
		if (err) {
			console.trace(err);
			res.send(500, { status: "error", message: err.toString() });
			return;
		}
		req.params.__user = req.user || null;
		req.Model[req.params.method_name](item).then(
			function(item) {
				// console.log({ action_id: 7, action: "Method called", type: req.modelname, id: item._id, method: req.params.method_name, user: filterLogUser(req.user) });
				res.json(item);
			},
			function(err) {
				console.trace(err);
				res.send(500, { status: "error", message: err.toString() });
			}
		);
	});
};

// var actionBatch = (req, res, next) => {
// 	console.time("BATCH " + req.modelname);
// 	var items = [];
// 	data = JSON.parse(req.params.json);
// 	data.forEach(function(data) {
// 		var item = new req.Model();
// 		if (req.user) {
// 			item.__user = req.user;
// 		}
// 		_populateItem(item, data);
// 		_versionItem(item);
// 		if (req.user) {
// 			item._owner_id = req.user._id;
// 		}
// 		items.push(item);
// 	});
// 	req.Model.create(items, function(err, docs) {
// 		if (err) {
// 			console.error(err);
// 			res.status(500).send(err.toString());
// 		} else {
// 			// websocket.emit(modelname, { method: "post", _id: result._id });
// 			console.log({ action_id: 8, action: "Batch insert", type: req.modelname, count: items.length, user: filterLogUser(req.user) });
// 			res.send({ message: req.modelname + " created ", data: items.length });
// 			console.timeEnd("BATCH " + req.modelname);
// 			return;
// 		}
// 	});
// };

// Meta

const metaModels = (req, res, next) => {
	model_dir = path.join(process.argv[1], "/../../models");
	fs.readdir(model_dir, function(err, files) {
		if (err) {
			console.trace(err);
			res.send(500, {
				status: "error",
				message: "Error reading models directory " + model_dir
			});
			return false;
		}
		var models = [];
		files.forEach(function(file) {
			var modelname = path.basename(file, ".js").replace("_model", "");
			try {
				var modelobj = require(model_dir + "/" + file);
				if (
					modelobj.schema &&
					modelobj.schema.get("_perms") &&
					(modelobj.schema.get("_perms").admin ||
						modelobj.schema.get("_perms").user ||
						modelobj.schema.get("_perms").owner ||
						modelobj.schema.get("_perms").all)
				) {
					var model = {
						model: modelname,
						file: file,
						perms: modelobj.schema.get("_perms")
					};
					models.push(model);
				}
			} catch (error) {
				console.error("Error with model " + modelname, error);
			}
		});
		res.send(models);
	});
};

const metaModel = (req, res) => {
	res.send(req.Model.schema.paths);
};

// Utitlities

const getOne = async (Model, item_id, params) => {
	const query = Model.findById(item_id);
	if (params.populate) {
		query.populate(params.populate);
	}
	if (params.autopopulate) {
		for (let key in Model.schema.paths) {
			var dirpath = Model.schema.paths[key];
			if (dirpath.instance == "ObjectID" && dirpath.options.ref) {
				query.populate(dirpath.path);
			}
		}
	}
	try {
		var item = await query.exec();
		if (!item) {
			console.error("Could not find document");
			return Promise.reject({ code: 404, msg: "Could not find document" });
		}
		if (item._deleted && !params.showDeleted) {
			console.error("Document is deleted");
			return Promise.reject({ code: 404, msg: "Document is deleted" });
		}
		item = item.toObject();
		//Don't ever return passwords
		delete item.password;
		return item;
	} catch(err) {
		console.error(err);
		return Promise.reject({ code: 500, msg: err });
	}
};

const parseFilter = (filter) => {
	if (!filter)
		return {};
	if (typeof filter == "object") {
		Object.keys(filter).forEach(function(key) {
			var val = filter[key];
			if (filter[key] === "false") filter[key] = false;
			if (filter[key] === "true") filter[key] = true;
			if (val.indexOf) {
				try {
					if (val.indexOf(":") !== -1) {
						var tmp = val.split(":");
						filter[key] = {};
						var tmpkey = tmp.shift();
						filter[key][tmpkey] = tmp.join(":");
					}
					if (typeof val == "object") {
						result = parseFilter(val);
						filter[key] = {};
						for (var x = 0; x < result.length; x++) {
							filter[key][Object.keys(result[x])[0]] =
								result[x][Object.keys(result[x])[0]];
						}
					}
				} catch (err) {
					throw err;
				}
			}
		});
	}
	return filter;
}

const _deSerialize = (data) => {
	function assign(obj, keyPath, value) {
		// http://stackoverflow.com/questions/5484673/javascript-how-to-dynamically-create-nested-objects-using-object-names-given-by
		lastKeyIndex = keyPath.length - 1;
		for (var i = 0; i < lastKeyIndex; ++i) {
			key = keyPath[i];
			if (!(key in obj)) obj[key] = {};
			obj = obj[key];
		}
		obj[keyPath[lastKeyIndex]] = value;
	}
	for (var datum in data) {
		var matches = datum.match(/\[(.+?)\]/g);
		if (matches) {
			var params = matches.map(function(match) {
				return match.replace(/[\[\]]/g, "");
			});
			if (isNaN(params[0])) {
				params.unshift(datum.match(/(.+?)\[/)[1]);
				assign(data, params, data[datum]);
			}
		}
	}
};

const _populateItem = (item, data) => {
	_deSerialize(data);
	for (let prop in item) {
		if (typeof data[prop] != "undefined") {
			item[prop] = data[prop];
			// Unset any blank values - essentially 'deleting' values on editing
			if (data[prop] === "") {
				item[prop] = null;
			}
		}
		//Check for arrays that come in like param[1]=blah, param[2]=yack
		if (data[prop + "[0]"]) {
			var x = 0;
			var tmp = [];
			while (data[prop + "[" + x + "]"]) {
				tmp.push(data[prop + "[" + x + "]"]);
				x++;
			}
			item[prop] = tmp;
		}
	}
};

const _versionItem = (item) => {
	if (item._version || item._version === 0) {
		item._version++;
	} else {
		item._version = 0;
	}
};

const _fixArrays = (req, res, next) => {
	if (req.body) {
		for (var i in req.body) {
			if (i.search(/\[\d+\]/) > -1) {
				var parts = i.match(/(^[A-Za-z]+)(\[)/);
				var el = parts[1];
				if (!req.body[el]) {
					req.body[el] = [];
				}
				req.body[el].push(req.body[i]);
			}
		}
	}
	next();
};

const changeUrlParams = (req, key, val) => {
	var q = req.query;
	q[key] = val;
	var pathname = require("url").parse(req.url).pathname;
	return req.config.url + req.path() + "?" + querystring.stringify(q);
};

const JExpress = function(options) {
	const server = restify.createServer();

	//Set up config with default
	var config = {
		model_dir: path.join(path.dirname(process.argv[1]), "../models"),
		mongo: {
			server: "localhost",
			db: "openmembers"
		},
		url: "http://localhost:3001",
		callbacks: {
			put: function() {},
			post: function() {},
			delete: function() {},
			get: function() {},
			getOne: function() {}
		},
		log: "access.log",
		pre_hooks: {
			get: (req, res, next) => {
				next();
			},
			getOne: (req, res, next) => {
				next();
			},
			post: (req, res, next) => {
				next();
			},
			put: (req, res, next) => {
				next();
			},
			delete: (req, res, next) => {
				next();
			}
		},
		post_hooks: {
			get: (modelname, result) => {},
			getOne: (modelname, id, result) => {},
			post: (modelname, id, data, result) => {},
			put: (modelname, id, data, result) => {},
			delete: (modelname, id, data, result) => {}
		}
	};

	//Override config with passed in options

	for (let i in options) {
		if (typeof config[i] === "object" && !Array.isArray(config[i])) {
			if (typeof options[i] === "object" && !Array.isArray(options[i])) {
				for (let j in options[i]) {
					config[i][j] = options[i][j]; // Second level object copy
				}
			}
		} else {
			config[i] = options[i];
		}
		if (i === "model_dir" || i === "log") {
			// Decide whether it's absolute or relative
			if (config.model_dir.charAt(0) === "/") {
				config[i] = options[i];
			} else {
				config[i] = path.join(
					path.dirname(process.argv[1]),
					options[i]
				);
			}
		}
	}

	// Pre-load models
	var files = fs.readdirSync(config.model_dir);
	modelnames = files.filter(function(fname) {
		return fname.indexOf("_model.js") !== -1;
	});
	modelnames.forEach(function(fname) {
		var modelname = fname.replace("_model.js", "");
		models[modelname] = require(path.join(config.model_dir, fname));
	});

	security.init(config);
	login.init(config);
	groups.init(config);

	// Set up our API server

	// Logging
	console.log("Logging to", config.log);

	var accessLogStream = fs.createWriteStream(config.log, { flags: "a" });
	server.use(morgan("combined", { stream: accessLogStream }));

	// CORS
	const corsMiddleware = require('restify-cors-middleware');

	const cors = corsMiddleware({
		preflightMaxAge: 5, //Optional
		origins: ['*'],
		allowHeaders: ['X-Requested-With','Authorization'],
		exposeHeaders: ['Authorization']
	});

	server.pre(cors.preflight);
	server.use(cors.actual);

	// Parse data
	server.use(restify.plugins.queryParser());
	server.use(restify.plugins.bodyParser());

	// Bind our config to req.config
	server.use((req, res, next) => {
		req.config = config;
		next();
	});

	// Define our endpoints

	/* Our API endpoints */
	server.get(
		"/api/:modelname",
		middlewareModel,
		security.login,
		security.auth,
		config.pre_hooks.get,
		cache.read.bind(cache),
		actionGet,
		outputJSON
	);
	server.get(
		"/api/:modelname/:item_id",
		middlewareModel,
		security.login,
		security.auth,
		config.pre_hooks.getOne,
		cache.read.bind(cache),
		actionGetOne
	);
	server.post(
		"/api/:modelname",
		middlewareModel,
		security.login,
		security.auth,
		middlewarePasswords,
		config.pre_hooks.post,
		actionPost,
		cache.flush.bind(cache)
	);
	server.put(
		"/api/:modelname/:item_id",
		middlewareModel,
		security.login,
		security.auth,
		middlewarePasswords,
		middlewareCheckAdmin,
		config.pre_hooks.put,
		actionPut,
		cache.flush.bind(cache)
	);
	server.del(
		"/api/:modelname/:item_id",
		middlewareModel,
		security.login,
		security.auth,
		config.pre_hooks.delete,
		actionDelete,
		cache.flush.bind(cache)
	);

	// CSV endpoints
	server.get(
		"/csv/:modelname",
		middlewareModel,
		security.login,
		security.auth,
		config.pre_hooks.get,
		cache.read.bind(cache),
		actionGet,
		outputCSV
	);

	/* Batch routes - ROLLED BACK FOR NOW */
	// server.post('/batch/create/:modelname', middlewareModel, security.login, security.auth, actionBatch);

	/* Call Methods in our models */
	server.get(
		"/call/:modelname/:method_name",
		middlewareModel,
		security.login,
		security.auth,
		actionCall
	);
	server.post(
		"/call/:modelname/:method_name",
		middlewareModel,
		security.login,
		security.auth,
		actionCall
	);
	server.get(
		"/call/:modelname/:item_id/:method_name",
		middlewareModel,
		security.login,
		security.auth,
		actionCallItem
	);

	/* Login and authentication */
	server.post("/login/recover", login.recover);
	server.post("/login/getjwt", security.login, login.getJWT);
	server.get("/login/logout", login.logout);
	server.post("/login/logout", login.logout);
	server.get("/login/oauth/:provider", login.oauth);
	server.get("/login/oauth/callback/:provider", login.oauth_callback);
	server.post("/login", login.login);

	/* Groups */
	server.put(
		"/groups/:user_id",
		security.login,
		security.admin_only,
		_fixArrays,
		groups.actionPut,
		cache.flush.bind(cache)
	);
	server.post(
		"/groups/:user_id",
		security.login,
		security.admin_only,
		_fixArrays,
		groups.actionPost,
		cache.flush.bind(cache)
	);
	server.get("/groups/:user_id", security.login, groups.actionGet);
	server.del("/groups/:user_id", security.login, security.admin_only, groups.actionDelete, cache.flush.bind(cache));

	/* Meta */
	server.get("/model/:modelname", middlewareModel, metaModel);
	server.get("/model", metaModels);

	/* Setup */
	server.get("/setup", setup.checkUserDoesNotExist, setup.setup);
	server.post("/setup", setup.checkUserDoesNotExist, setup.setup, cache.flush.bind(cache));

	return server;
};

module.exports = JExpress;
