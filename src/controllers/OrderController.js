/*
OrderController.js: handles management of Orders.
An order is a collection of OrderRequests being ordered from a specific supplier.
It is expected that once an OrderRequest is in an order, it has a specific Item assigned to it,
and a specific stock of that item.
 */
let express = require('express');

/* Wrap our router in our auth protocol */
let router = express.Router();
let authMiddleware = require('../middleware/AuthMiddleware');
let Order = require('./../models/Order');
let Transaction = require('./../models/Transaction');
let bodyParser = require('body-parser');
let adminMiddleware = require('../middleware/AdminMiddleware');
let Item = require('./../models/Item');
let OrderRequest = require('../models/OrderRequest');
const config = require('../config')();

router.use(bodyParser.json());
router.use(authMiddleware);

/**
 * GET: / Get orders.
 *  Accepts following parameters: 
 *  start_date: first order date to show, seconds since unix epoch
 *  end_date: latest order date to show, seconds since unix epoch
 *  active: should only active orders be returned
 */
router.get('/', function (req, res) {
    // set start and end, or use default values if they were not given.
    let start = isNaN(parseInt(req.query.start_date)) ? 0 : parseInt(req.query.start_date);
    let end = isNaN(parseInt(req.query.end_date)) ? Date.now() : parseInt(req.query.end_date);
    let active = req.query.active;
    // Create date objects from timestamps
    let query = { date_created: { $gt: new Date(start), $lt: new Date(end) } };
    if (active) {
        query['status'] = "In Cart";
    }
    Order.find(
        query,
        function (err, orders) {
            if (err) return res.status(500);
            return res.status(200).send(orders);
        });
});

/**
 * GET /:id: get a specific order by its ID
 * :id: ID of order
 */
router.get('/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("No order found");
        res.status(200).send(order);
    } catch (err) {
        res.status(500).send(err);
    }

});

// require admin permissions to use the below endpoints
router.use(adminMiddleware);


/**
 * POSTs a new order
 * POST body:
 * {
 *   supplier: String
 * }
 */
router.post('/', async (req, res) => {
    if (!req.body.supplier) {
        return res.status(400).send("No supplier provided");
    }
    try {
        const supplier = req.body.supplier;
        // create order using populated item refs
        let newOrder = await Order.create({ supplier: supplier, date_created: new Date(), status: "In Cart" });
        res.status(200).send(newOrder);
    } catch (err) {
        // push error back to frontend user
        console.log(err);
        res.status(500).send(err);
    }
});

/**
 * Updates the stock of an Item asynchronously
 * used when an order is marked as completed, to increase stock of items in database
 * @param itemID: ID of Item to update stock of
 * @param quantity: quantity of item that has been shipped
 * @return {Promise<OrderRequest>}
 */
async function updateItemStock(itemID, quantity) {
    // not using try/catch because we want errors to be caught by callers
    const itemRef = await Item.findById(itemID);
    if (!itemRef) {
        // throw error so the frontend knows something went wrong
        throw { err: "Stock update requested for invalid item" };
    }
    itemRef.stock += quantity;
    const restockedItem = await itemRef.save();
    if (!restockedItem) {
        throw { err: "Failed to save new stock state of item" };
    }
    return restockedItem;
}


/**
 * Moves order request from a request into an actual item on provided transactions. Deletes the reference to
 * the order request, and adds the item. Effectively "fulfills" the order request.
 * @param {ObjectID} requestID: ID of order request to fulfill on transactions
 * @param {number[]} transactions: transactions to add item to. One of the item associated to the request will be added to each transaction in the array
 *                                  (so if a transaction appears twice, two items will be added)
 */
async function fulfillOrderRequests(requestID, transactions) {
    // not using try/catch because we want errors to be caught by callers
    const requestRef = await OrderRequest.findById(requestID);
    if (!requestRef) {
        throw { err: "Could not locate order request to fulfill" };
    }
    const itemRef = await Item.findById(requestRef.itemRef._id);
    if (!itemRef) {
        // throw error so the frontend knows something went wrong
        throw { err: "Could not locate item to add to transaction" };
    }
    for (let transaction_id of transactions) {
        const transactionRef = await Transaction.findById(transaction_id);
        if (!transactionRef) {
            throw { err: "Could not find transaction to add item to" };
        }
        let price = (transactionRef.employee && (itemRef.wholesale_cost > 0)) ? itemRef.wholesale_cost * config.employee_price_multiplier : itemRef.standard_price;
        transactionRef.items.push({ item: itemRef, price: price });
        /**
         * Note that we do not update the order request here. Once an order request is completed, the relationship between the
         * transaction's orderRequests field and the order request's transactions field can break, and will.
         */
        transactionRef.orderRequests.splice(transactionRef.orderRequests.findIndex(x => x._id == requestRef._id), 1)
        transactionRef.total_cost += price;
        await transactionRef.save()
    }
}

/**
 * Moves actual item on provided transactions back to an order request. Deletes the reference to
 * the item. Effectively "unfulfills" the order request.
 * @param {ObjectID} requestID: ID of order request to unfulfill on transactions
 * @param {number[]} transactions: transactions to add item to. One of the item associated to the request will be added to each transaction in the array
 *                                  (so if a transaction appears twice, two items will be added)
 */
async function unfulfillOrderRequests(requestID, transactions) {
    // not using try/catch because we want errors to be caught by callers
    const requestRef = await OrderRequest.findById(requestID);
    if (!requestRef) {
        throw { err: "Could not locate order request to add to transaction" }
    }
    const itemRef = await Item.findById(requestRef.itemRef._id);
    if (!itemRef) {
        // throw error so the frontend knows something went wrong
        throw { err: "Could not locate item to remove from transaction" };
    }
    for (let transaction_id of transactions) {
        const transactionRef = await Transaction.findById(transaction_id);
        if (!transactionRef) {
            throw { err: "Could not find transaction to add item to" };
        }
        transactionRef.items.splice(transactionRef.items.findIndex(x => x.item._id.toString() == itemRef._id.toString()), 1);
        /**
         * Note that we do not update the order request here. Once an order request is completed, the relationship between the
         * transaction's orderRequests field and the order request's transactions field can break, and will.
         */
        transactionRef.orderRequests.push(requestRef);
        let price = (transactionRef.employee && (itemRef.wholesale_cost > 0)) ? itemRef.wholesale_cost * config.employee_price_multiplier : itemRef.standard_price;
        transactionRef.total_cost -= price;
        await transactionRef.save()
    }
}

/**
 * PUT /:id/supplier: updates supplier
 * put body:
 * {
 *     supplier: new supplier
 * }
 */
router.put('/:id/supplier', async (req, res) => {
    try {
        if (!req.body.supplier) return res.status(400).send("No supplier specified");
        let order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("No order found");
        // Update the supplier of all Order Requests in this order
        const promises = order.items.map(async item => {
            const locatedItem = OrderRequest.findById(item._id);
            locatedItem.supplier = req.body.supplier;
            await locatedItem.save();
        });
        await Promise.all(promises);
        order.supplier = req.body.supplier;
        const savedOrder = await order.save();
        return res.status(200).send(savedOrder);
    } catch (err) {
        res.status(500).send(err);
    }
});

/**
 * POST /:id/order-request: adds OrderRequest to order
 * post body:
 * {
 *    order_request_id: ID of order request
 * }
 */
router.post('/:id/order-request', async (req, res) => {
    try {
        if (!req.body.order_request_id) return res.status(400).send("No order request specified");
        const orderRequest = await OrderRequest.findById(req.body.order_request_id);
        if (!orderRequest) return res.status(404).send("Order request specified, but none found!");
        if (orderRequest.orderRef) {
            return res.status(403).send("Cannot associate order request, already associated to another order");
        }
        if (!orderRequest.itemRef) {
            return res.status(403).send("Order request must have an associated item to be added to an order");
        }
        if (orderRequest.quantity < 1) {
            return res.status(400).send("Order request has bad quantity: " + orderRequest.quantity);
        }
        let order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("No order found");
        // update OrderRequest to match order
        orderRequest.orderRef = order._id;
        orderRequest.status = order.status;
        orderRequest.supplier = order.supplier;
        const savedReq = await orderRequest.save();
        // Add item price to total price of order.
        order.total_price += savedReq.itemRef.wholesale_cost * savedReq.quantity;
        // add item as first in order
        order.items.unshift(savedReq);
        const savedOrder = await order.save();
        res.status(200).send(savedOrder);
    } catch (err) {
        res.status(500).send(err);
    }
});

/**
 * DELETE /:id/order-request/:reqId
 * deletes an order request from the order by the given reqId (for the order request)
 * Does not delete order request, simply disassociates it with the order.
 */
router.delete('/:id/order-request/:reqId', async (req, res) => {
    try {
        let order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("No order found");
        const orderRequest = await OrderRequest.findById(req.params.reqId);
        if (!orderRequest) return res.status(404).send("Order request not found in this order");
        // remove the requested request from the array
        order.items = order.items.filter(candidate => {
            if (candidate._id.toString() === orderRequest._id.toString()) {
                // Adjust price of order.
                order.total_price -= candidate.itemRef.wholesale_cost * candidate.quantity;
                return false; // item will be removed
            }
            return true;
        });
        orderRequest.status = "Not Ordered";
        orderRequest.supplier = null;
        orderRequest.orderRef = null;
        await orderRequest.save();
        const finalOrder = await order.save();
        return res.status(200).send(finalOrder);
    } catch (err) {
        res.status(500).send(err);
    }
});

/**
 * PUT /:id/tracking_number: updates an order's tracking number
 * put body:
 * {
 *    tracking_number: new order tracking number
 * }
 */
router.put('/:id/tracking_number', async (req, res) => {
    try {
        if (!req.body.tracking_number) return res.status(400).send("No tracking number specified");
        let order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("No order found");
        order.tracking_number = req.body.tracking_number;
        const savedOrder = await order.save();
        return res.status(200).send(savedOrder);
    } catch (err) {
        res.status(500).send(err);
    }
});

/**
 * DELETE /:id : deletes an order by it's ID
 */
router.delete('/:id', async (req, res) => {
    try {
        let order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("No order found");
        // Remove the order id from all order requests in order.
        for (let orderReqId of order.items) {
            let orderReq = await OrderRequest.findById(orderReqId);
            orderReq.orderRef = null;
            orderReq.status = "Not Ordered";
            await orderReq.save();
        }
        await order.remove();
        return res.status(200).send("OK")
    } catch (err) {
        res.status(500).send(err);
    }
});

/**
 * PUT /:id/freight-charge: updates an order's freight/shipping cost
 * put body:
 * {
 *      charge: freight charge
 * }
 */
router.put('/:id/freight-charge', async (req, res) => {
    try {
        if (req.body.charge == null) {
            return res.status(400).send("A freight charge must be specified");
        }
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).send("No order with given ID found");
        }
        if (!order.freight_charge) order.freight_charge = 0;
        const difference = req.body.charge - order.freight_charge;
        order.freight_charge = req.body.charge;
        order.total_price += difference;
        const savedOrder = await order.save();
        return res.status(200).send(savedOrder);
    } catch (err) {
        res.status(500).send(err);
    }
})

/**
 * PUT /:id/status: updates an order's status
 * If the order is completed, date_completed will be set (as well as date_submitted if it was null)
 * If the order is ordered, date_submitted will be set
 * put body:
 * {
 *     status: new status string of the order
 * }
 */
router.put('/:id/status', async (req, res) => {
    try {
        if (!req.body.status) return res.status(400).send("No status specified");
        let order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("No order found");
        if (req.body.status === "In Cart") {
            // clear out the submission date and completion date
            order.date_completed = null;
            order.date_submitted = null;
        }
        if (req.body.status === "Ordered") {
            order.date_submitted = new Date(); // order was just submitted
            order.date_completed = null; // clear this out to prevent undefined state
        }
        if (req.body.status === "Completed" && order.status !== "Completed") {
            // update item stocks
            let promises = order.items.map(item => updateItemStock(item.itemRef._id, item.quantity));
            await Promise.all(promises);    // await for all promises to resolve
            promises = order.items.map(item => fulfillOrderRequests(item._id, item.transactions));
            await Promise.all(promises);    // wait for all transactions to get items added
            // Find the order again here. The additional query forces the new item stocks to populate.
            order = await Order.findById(order._id);
            // set date_completed
            order.date_completed = new Date();
            // If order was not marked as in cart, just set date to now
            if (order.date_submitted == null) {
                order.date_submitted = new Date();
            }
        } else if (req.body.status !== "Completed" && order.status === "Completed") {
            // decrease item stocks
            let promises = order.items.map(item => updateItemStock(item.itemRef._id, -1 * item.quantity));
            await Promise.all(promises);    // await for all promises to resolve
            promises = order.items.map(item => unfulfillOrderRequests(item._id, item.transactions));
            await Promise.all(promises);    // wait for all transactions to get items removed
            // Find the order again here. The additional query forces the new item stocks to populate.
            order = await Order.findById(order._id);
        }
        // Update the status of all Order Items in this order
        const promises = order.items.map(async item => {
            const locatedItem = await OrderRequest.findById(item._id);
            locatedItem.status = req.body.status;
            await locatedItem.save();
        });
        await Promise.all(promises);
        order.status = req.body.status;
        const savedOrder = await order.save();
        const updatedOrder = await Order.findById(savedOrder._id);
        return res.status(200).send(updatedOrder);
    } catch (err) {
        res.status(500).send(err);
    }
});

module.exports = router;
